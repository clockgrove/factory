// The usage artifact's transcript and event stream, sealed (#490).
//
// A usage artifact (`pendulum-usage-<issue>`, `-review`) is downloadable by anyone who can read the repository's
// Actions artifacts: on a public repository, anyone signed in to GitHub. The harness's event stream (`events.jsonl`)
// and its saved sessions (`transcript/`) hold what the agent read and ran, so unless the adopter publishes them
// (`publish_transcripts`) or the repository is private, they go into the artifact sealed: one gzipped tar of them,
// encrypted with AES-256-GCM (Node's crypto) under a key derived with HKDF-SHA256 from the Pendulum App's private key
// and the repository's name, its additional data naming the Objective and the stage and holding a hash of the usage
// record's session (recordDigest: the session, its files and checkout, its total, which seeds the resumed session's
// cost, and the stage's totals that bound a Copilot seed), so a record altered beside an untouched sealed file refuses the resume. Every job that
// uploads or resumes holds that key already (the work, review, launch and sweep jobs), and a cloud sandbox stage gets
// the derived key alone (PENDULUM_SEAL_KEY), never the App's key. The usage record (`result.json`) stays readable: the
// scorer and daily_usd read it, and it carries the stream's call and session counts (`sessions`) the scorer would
// otherwise read from the stream. Under the sealed policy a resume takes only a sealed session that opens with this
// repository's key: anyone able to upload an artifact of the same name could otherwise plant one. Under the published
// policy a session is readable, so a resume takes one only from a run of this repository's Pendulum workflow
// (artifactRunProblem).
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, hkdfSync, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import canonicalize from "../../vendor/canonicalize/lib/canonicalize.js";
import { normalizePem } from "./app-token.mjs";
import { log } from "./inputs.mjs";
import { SAFE_PATH, runnerCommand } from "./proc.mjs";
import { streamSessions } from "./usage.mjs";

/** What the seal covers, by name in the usage directory: the harness's event stream and its saved sessions. */
export const PRIVATE_ENTRIES = ["events.jsonl", "transcript"];
/** The sealed file in the artifact (no `.json` or `.jsonl` name: the scorer reads those as usage). */
export const SEALED_FILE = "transcript.sealed";
// The file: MAGIC, a 12-byte random nonce, the ciphertext and the 16-byte GCM tag. The additional data is MAGIC and the
// binding (sealBinding): a sealed file opens only for the Objective, stage and usage record it was made for.
const MAGIC = Buffer.from("PNDSEAL2");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEAD_BYTES = MAGIC.length + NONCE_BYTES;

/**
 * The seal's key for `repoFull`: HKDF-SHA256 over the App private key's PKCS#8 DER (the PEM restored as appJwt restores
 * it, then the same bytes whatever its line endings), salted for this use, bound to the repository's name. Null without
 * a key that parses.
 */
export function sealKey(appPrivateKey, repoFull) {
  if (!appPrivateKey || !repoFull) return null;
  let der;
  try {
    der = createPrivateKey(normalizePem(appPrivateKey)).export({ type: "pkcs8", format: "der" });
  } catch {
    return null;
  }
  return Buffer.from(hkdfSync("sha256", der, Buffer.from("pendulum usage seal"), Buffer.from(`v1 ${String(repoFull).toLowerCase()}`), 32));
}

/** Why there is no seal key: an App key given that did not parse, or none given; null when there is a key. */
export const sealKeyProblem = (appPrivateKey, key) => (key ? null : appPrivateKey ? "the App private key did not parse" : "no App private key");

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

/**
 * Why an artifact's run (`run`, the run as GitHub's REST API reads it) is not one a published session is resumed from,
 * or null when it is: a run in `repoFull` itself (never a fork's pull request, whose run takes the workflow file as the
 * fork has it) of the workflow file at `workflowPath`, this repository's Pendulum workflow. Under the published policy
 * the session is readable, so nothing else vouches for it.
 */
export function artifactRunProblem(run, { repoFull, workflowPath }) {
  const why = `with publish_transcripts on, a resume takes a session only from a run of ${workflowPath} in this repository`;
  if (!run || typeof run !== "object") return `the artifact's run could not be read: ${why}`;
  if (String(run.repository?.full_name ?? "").toLowerCase() !== String(repoFull).toLowerCase()) return `the artifact's run is in ${run.repository?.full_name ?? "an unnamed repository"}: ${why}`;
  if (!Number.isInteger(run.repository?.id) || run.head_repository?.id !== run.repository.id) return `the artifact's run is on a fork's pull request (${run.head_repository?.full_name ?? "an unnamed head repository"}): ${why}`;
  if (run.path !== workflowPath) return `the artifact's run is of ${run.path ?? "an unnamed workflow"}: ${why}`;
  return null;
}

/** A usage artifact's stage, by its name: `pendulum-usage-<n>-review` is the review stage's, any other the work stage's. */
export const artifactStage = (name) => (/-review$/.test(String(name || "")) ? "review" : "work");

/** What recordDigest binds of a usage record, by its top-level name. */
const RECORD_BOUND = ["session", "sessionTotal", "usd", "tokens", "aiCredits", "premiumRequests"];

/**
 * The SHA-256 (hex) of what a resume takes from a usage directory's record (`result.json`): its `session` (the id,
 * harness, files and checkout), its `sessionTotal` (the resumed session's cost seed) and the stage's own totals a
 * Copilot seed is bounded by when there is no sessionTotal (`usd`, `tokens`, `aiCredits`, `premiumRequests`; usage.mjs
 * clampTotal), in RFC 8785 canonical JSON, so the same record hashes the same however it was written out. A field
 * missing, or the whole record unreadable, hashes as null; a record no canonical form exists for (a lone surrogate)
 * throws.
 */
export function recordDigest(dir) {
  let rec = null;
  try {
    rec = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  } catch {
    rec = null;
  }
  const take = rec && typeof rec === "object" && !Array.isArray(rec) ? rec : {};
  const bound = Object.fromEntries(RECORD_BOUND.map((k) => [k, take[k] ?? null]));
  return createHash("sha256").update(canonicalize(bound)).digest("hex");
}

/** The additional data: MAGIC and what the sealed file is for (the Objective, the stage, the record's digest). */
const sealBinding = ({ issue, stage, record }) => Buffer.concat([MAGIC, Buffer.from(JSON.stringify({ issue: Number(issue) || 0, stage: stage === "review" ? "review" : "work", record: record ?? null }))]);

/** The private entries present in `dir`: a regular file or a directory each, never a link. */
const presentEntries = (dir) => PRIVATE_ENTRIES.filter((n) => {
  const st = lstatSync(join(dir, n), { throwIfNoEntry: false });
  return !!st && (st.isFile() || st.isDirectory());
});

/** A copy filter: regular files and directories only (no link, socket or device). */
const plainOnly = (src) => {
  const st = lstatSync(src, { throwIfNoEntry: false });
  return !!st && (st.isFile() || st.isDirectory());
};

/** Every symlink under `dir` removed (a sealed archive is authenticated, but nothing it holds is ever followed). */
function dropLinks(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) unlinkSync(p);
    else if (st.isDirectory()) dropLinks(p);
  }
}

/** Runs the system `tar` (runnerCommand: the system directories' only, PATH fixed) with `args`, its stdout into `sink` when given. */
function tar(args, sink = null) {
  const [bin, env] = runnerCommand("tar", { PATH: SAFE_PATH });
  const child = spawn(bin, args, { env, stdio: ["ignore", sink ? "pipe" : "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err = (err + d).slice(-400)));
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim()}`))));
  });
  return sink ? Promise.all([pipeline(child.stdout, ...sink), exited]) : exited;
}

/** Seal `names` of `dir` into `file` (a gzipped tar, encrypted under `key` for `binding`). */
async function sealInto(dir, names, file, key, binding) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(sealBinding(binding));
  const part = `${file}.part`;
  writeFileSync(part, Buffer.concat([MAGIC, nonce]), { mode: 0o600 });
  await tar(["czf", "-", "-C", dir, "--", ...names], [cipher, createWriteStream(part, { flags: "a" })]);
  appendFileSync(part, cipher.getAuthTag());
  renameSync(part, file);
}

/**
 * The stream's harness calls and sessions (`events`, a file) into the usage record in `dir` (`sessions`, as the scorer
 * reads it from the stream), when there are both; the record is left as it is otherwise.
 */
function recordSessions(dir, events) {
  const result = join(dir, "result.json");
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
 * The upload directory `to` from a stage's usage directory `from`, under `policy`, made beside `to` and renamed into
 * place as the last act: every regular file and directory but the transcript and the stream (no link, socket or device),
 * the stream's counts in the usage record, then the transcript and the stream readable (`private`, `published`) or, when
 * sealed, tarred straight from `from` and sealed under `key` for `bind` ({issue, stage}; the record's digest is the
 * uploaded record's, recordDigest).
 * They are never written into the upload readable under the sealed policy: with no key, or a seal that failed, they are
 * left out. A throw leaves no `to` at all. Returns {policy, sealed, dropped} (the names) and a failed seal's `error`.
 */
export async function prepareUpload({ from, to, policy, key, bind = {} }) {
  const part = `${to}.part`;
  for (const d of [to, part]) rmSync(d, { recursive: true, force: true });
  mkdirSync(part, { recursive: true, mode: 0o700 });
  const out = { policy, sealed: [], dropped: [] };
  try {
    if (existsSync(from)) {
      for (const name of readdirSync(from)) {
        if (PRIVATE_ENTRIES.includes(name) || name === SEALED_FILE || name.startsWith(".unseal-")) continue;
        cpSync(join(from, name), join(part, name), { recursive: true, filter: plainOnly });
      }
    }
    recordSessions(part, join(from, "events.jsonl"));
    const names = existsSync(from) ? presentEntries(from) : [];
    if (names.length && policy !== "sealed") {
      for (const n of names) cpSync(join(from, n), join(part, n), { recursive: true, filter: plainOnly });
    } else if (names.length) {
      if (key) {
        try {
          await sealInto(from, names, join(part, SEALED_FILE), key, { ...bind, record: recordDigest(part) });
          out.sealed = names;
        } catch (e) {
          for (const f of [SEALED_FILE, `${SEALED_FILE}.part`]) rmSync(join(part, f), { force: true });
          out.error = String(e.message).slice(0, 200);
        }
      }
      if (!out.sealed.length) out.dropped = names;
    }
    renameSync(part, to);
  } catch (e) {
    rmSync(part, { recursive: true, force: true });
    throw e;
  }
  return out;
}

/**
 * A cloud sandbox stage's usage directory `dir`, unpacked on the launch or sweep job's runner, made ready for upload in
 * place: moved aside, then prepareUpload from it back into `dir` under the job's seal (usageSeal; with none, sealed with
 * no key: the transcript and the stream left out) for `bind` ({issue, stage}). Any failure leaves no `dir` and throws.
 * `what` names it in the log.
 */
export async function sealCollected(dir, seal, bind, what = "the usage") {
  const raw = `${dir}.raw`;
  rmSync(raw, { recursive: true, force: true });
  try {
    renameSync(dir, raw);
    const policy = seal ? await seal.policy() : "sealed";
    const r = await prepareUpload({ from: raw, to: dir, policy, key: seal?.key ?? null, bind });
    if (r.sealed.length) log(`${what}: ${r.sealed.join(" and ")} sealed in the usage artifact`);
    else if (r.dropped.length) log(`${what}: ${r.dropped.join(" and ")} left out of the usage artifact: ${r.error ? `the seal failed (${r.error})` : "no key to seal them with"}`);
    return r;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
}

/**
 * A downloaded artifact's session for a resume, in `dir`, under `policy`: its SEALED_FILE opened with `key` for `bind`
 * ({issue, stage}; the digest of the record beside it, recordDigest), which then alone supplies the transcript and the
 * stream (a readable copy beside it is removed first). Under the sealed policy an artifact without one is refused: only
 * a session sealed with this repository's key is resumed. Returns {ok: true}, or {ok: false, reason} (nothing is put back).
 */
export async function openSealed(dir, key, { policy = "sealed", bind = {} } = {}) {
  const file = join(dir, SEALED_FILE);
  if (!existsSync(file)) return policy === "sealed" ? { ok: false, reason: "the earlier session is not sealed: on a public repository only a session sealed with this repository's key is resumed" } : { ok: true };
  for (const n of PRIVATE_ENTRIES) rmSync(join(dir, n), { recursive: true, force: true });
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
  let record;
  try {
    record = recordDigest(dir);
  } catch {
    return { ok: false, reason: "the usage record's session has no canonical form (an altered record)" };
  }
  // Unpacked beside the record (one filesystem), then moved into place.
  const work = mkdtempSync(join(dir, ".unseal-"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
    decipher.setAAD(sealBinding({ ...bind, record }));
    decipher.setAuthTag(tag);
    const tgz = join(work, "t.tgz");
    // GCM authenticates at the end: the archive is unpacked only once the whole file checked out.
    try {
      await pipeline(createReadStream(file, { start: HEAD_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(tgz, { mode: 0o600 }));
    } catch {
      return { ok: false, reason: "the sealed session did not open: another key (the App's private key changed, or another repository's), another Objective's or stage's file, an altered one, or an altered usage record (its session or sessionTotal)" };
    }
    const out = join(work, "out");
    mkdirSync(out);
    await tar(["xzf", tgz, "-C", out, "--no-same-owner", "--no-same-permissions"]);
    dropLinks(out);
    for (const n of PRIVATE_ENTRIES) if (existsSync(join(out, n))) renameSync(join(out, n), join(dir, n));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `the sealed session could not be unpacked (${String(e.message).slice(0, 120)})` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
