// Mint a short-lived installation token from the adopter's Factory GitHub App.
// Node's crypto signs the RS256 JWT, so no dependency and no extra action is
// needed; the same code serves the Action and `/factory doctor` on a laptop.
// Factory never creates an App; it only verifies and uses the one it is given.
import { createSign } from "node:crypto";
import { NetworkDown, OUTAGE, UNREACHABLE, causeCode, downFor, networkBack, stoppedWaiting, waitingOutages } from "./network.mjs";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The App JWT (RFC 7519, RS256), valid for 9 minutes, issued 30 s in the past for clock skew. */
export function appJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(normalizePem(privateKeyPem));
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Secrets pasted into GitHub sometimes lose their newlines; restore the PEM body to 64-column lines. */
export function normalizePem(pem) {
  const s = String(pem || "").trim();
  if (s.includes("\n")) return s;
  const m = /^(-----BEGIN [A-Z ]+-----)\s*(.*?)\s*(-----END [A-Z ]+-----)$/.exec(s);
  if (!m) return s;
  return `${m[1]}\n${m[2].replace(/\s+/g, "").replace(/(.{64})/g, "$1\n").trim()}\n${m[3]}\n`;
}

const API = process.env.GITHUB_API_URL || "https://api.github.com";

async function api(path, { token, method = "GET", body } = {}) {
  const r = await fetchOrNoAnswer(`${API}/${path.replace(/^\//, "")}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clockgrove-factory",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!r.ok) {
    const e = new Error(`${method} ${path}: HTTP ${r.status} ${json?.message || text.slice(0, 200)}`);
    e.status = r.status;
    // GitHub throttling (its headers say so), not a refusal of the mint itself: transient, as github.mjs's GitHubError says it.
    e.rateLimited = r.status === 429 || (r.status === 403 && (r.headers.get("x-ratelimit-remaining") === "0" || r.headers.has("retry-after")));
    throw e;
  }
  return json;
}

/**
 * fetch, its own failure (the network, DNS, a timeout) tagged `transport`: no answer, as github.mjs's GitHubError says it,
 * with fetch's error as its cause and its connect-level code. In a process that waits outages out (network.mjs), a mint
 * that never left this machine waits for GitHub to answer and goes again; past the stage's limit it throws NetworkDown,
 * which the stage ends on (paused locally, an `outage` Block elsewhere).
 */
async function fetchOrNoAnswer(url, init) {
  for (;;) {
    try {
      return await fetch(url, init);
    } catch (e) {
      const code = causeCode(e);
      const origin = new URL(url).origin;
      if (UNREACHABLE.has(code) && waitingOutages()) {
        await networkBack(origin, code);
        continue;
      }
      if (UNREACHABLE.has(code) && stoppedWaiting()) throw downFor(origin) ?? new NetworkDown({ origin, code, since: OUTAGE.now() });
      throw Object.assign(new Error(`${init.method} ${url}: ${e.message}`, { cause: e }), { status: 0, transport: true, code, unsent: UNREACHABLE.has(code) });
    }
  }
}

/**
 * The Factory App's repository permissions: the one list setup, doctor and the docs name (APP_PERMISSIONS_TEXT). Every
 * route fails without one of these: the writes Factory makes, and the reads of required checks (check runs and commit
 * statuses); metadata read comes with every App. Projects is checked apart (PROJECT_PERMISSION_KEYS).
 */
export const APP_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" });
/**
 * Granted or not, never extra: actions read lets a cloud-sandbox stage, which has no job token, read a red required
 * check's job and log (reds.mjs, triage.mjs notStartedJobs) with the App's token.
 */
export const APP_OPTIONAL_PERMISSIONS = Object.freeze({ actions: "read" });
/** Projects v2 is granted by the App's org/user "projects" permission; the installation reports it as `organization_projects`. */
export const PROJECT_PERMISSION_KEYS = ["organization_projects", "projects"];
/** The list as the docs and doctor say it (README, the factory-setup skill and doctor's lines carry this exact text). */
export const APP_PERMISSIONS_TEXT = "contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows";

/**
 * What a granted permission set lacks of APP_PERMISSIONS (a write counts for a read), and what it has beyond the list
 * and APP_OPTIONAL_PERMISSIONS, or above its level (checks:write where Factory reads): ["name:level", ...] each.
 * `userAccount`: the App is installed on a personal account, whose Projects board no GitHub App can reach (Projects is an
 * organization permission), so projects is not required there: the board is skipped and labels carry the state (#199).
 */
export function permissionGaps(perms = {}, { userAccount = false } = {}) {
  const rank = { none: 0, read: 1, write: 2, admin: 3 };
  const allowed = { ...APP_PERMISSIONS, ...APP_OPTIONAL_PERMISSIONS, ...Object.fromEntries(PROJECT_PERMISSION_KEYS.map((k) => [k, "write"])) };
  const extra = Object.entries(perms)
    .filter(([k, v]) => v && v !== "none" && (rank[v] ?? 3) > (rank[allowed[k]] ?? 0))
    .map(([k, v]) => `${k}:${v}`);
  const missing = Object.entries(APP_PERMISSIONS)
    .filter(([k, v]) => (rank[perms[k]] ?? 0) < rank[v])
    .map(([k, v]) => `${k}:${v}`);
  if (!userAccount && !PROJECT_PERMISSION_KEYS.some((k) => perms[k] === "write" || perms[k] === "admin")) missing.push("projects:write");
  return { missing, extra };
}

/**
 * Mint an installation token scoped to one repository. Returns
 * {token, expiresAt, permissions, installationId, appSlug, extra}, where `extra`
 * lists granted permissions beyond APP_PERMISSIONS (permissionGaps), which doctor warns on, and `missing` what it lacks
 * of them, which doctor and setup fail on.
 */
export async function mintInstallationToken({ appId, privateKey, owner, repo, permissions = null, narrowTo = null }) {
  if (!appId || !privateKey) throw new Error("app_id and app_private_key are required");
  const jwt = appJwt(appId, privateKey);
  const app = await api("app", { token: jwt });
  const inst = await api(`repos/${owner}/${repo}/installation`, { token: jwt });
  const granted = inst.permissions || {};
  // `narrowTo`: the permissions wanted, each no higher than the installation's grant, and none it lacks.
  if (narrowTo) {
    const rank = { read: 1, write: 2, admin: 3 };
    permissions = Object.fromEntries(
      Object.entries(narrowTo)
        .filter(([k]) => granted[k] && granted[k] !== "none")
        .map(([k, v]) => [k, (rank[v] ?? 0) > (rank[granted[k]] ?? 0) ? granted[k] : v]),
    );
  }
  // `permissions`: a subset of the installation's, for a narrower token (the agent's read-only one, token-keeper.mjs).
  const tok = await api(`app/installations/${inst.id}/access_tokens`, { token: jwt, method: "POST", body: { repositories: [repo], ...(permissions ? { permissions } : {}) } });
  if (permissions) return { token: tok.token, expiresAt: tok.expires_at, permissions: tok.permissions || {}, repositories: (tok.repositories || []).map((r) => r.full_name), installationPermissions: granted, installationId: inst.id, appSlug: app.slug, appName: app.name, extra: [], missing: [] };
  const perms = tok.permissions || granted;
  const userAccount = inst.account?.type === "User";
  const { missing, extra } = permissionGaps(perms, { userAccount });
  return { token: tok.token, expiresAt: tok.expires_at, permissions: perms, installationId: inst.id, appSlug: app.slug, appName: app.name, extra, missing, userAccount };
}

/** All a notice needs: a comment on the issue, by the App, so GitHub notifies the person it mentions. */
export const NOTICE_PERMISSIONS = { issues: "write" };

/**
 * Local mode's notice token (#2522): local runs write as the operator's own login, and GitHub notifies no one of their
 * own @mention, so Blocked and Question notices post with the Factory App instead. Only local.mjs, the parent of every
 * stage, holds the App's key and calls this: an installation token for the one repository (`repositories` on the
 * access_tokens call) narrowed to NOTICE_PERMISSIONS, minted on first use and again near expiry, in memory only. A
 * token that came back for any other repository, or with more than issues write, is refused.
 */
export function noticeMinter({ appId, privateKey, owner, repo }) {
  let cur = null;
  let pending = null;
  const mint = async () => {
    const minted = await mintInstallationToken({ appId, privateKey, owner, repo, permissions: NOTICE_PERMISSIONS });
    const repos = minted.repositories || [];
    if (repos.length !== 1 || repos[0].toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error(`the notice token came back for ${repos.join(", ") || "no listed repository"}, not ${owner}/${repo}; refusing it`);
    const wider = Object.entries(minted.permissions || {}).filter(([k, v]) => k !== "metadata" && !(k === "issues" && v === "write"));
    if (wider.length) throw new Error(`the notice token came back with ${wider.map(([k, v]) => `${k}:${v}`).join(", ")}; refusing it`);
    return minted;
  };
  return async () => {
    if (cur && Date.parse(cur.expiresAt) - Date.now() > 5 * 60_000) return cur;
    // One mint in flight, shared by every stage asking at once.
    pending ??= mint()
      .then((m) => (cur = m))
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/**
 * What the App's key on this box can do beyond notices: its installation's grants other than issues write and metadata
 * read. Narrowing at mint time limits Factory, not the key, which mints whatever the installation has, for every
 * installation of the App. Empty for a notice-only App.
 */
export const noticeAppExtra = (installationPermissions = {}) =>
  Object.entries(installationPermissions)
    .filter(([k, v]) => v && v !== "none" && !(k === "metadata" && v === "read") && !(k === "issues" && (v === "write" || v === "read")))
    .map(([k, v]) => `${k}:${v}`);

// A stage asks its parent for the notice token over Node's IPC channel (spawn stdio "ipc"), so the App's key never leaves the parent. Node opens that channel close-on-exec in the
// stage and drops NODE_CHANNEL_FD from its env, so nothing the stage starts (the harness, the repository's commands)
// inherits it (plugin/test/backend.test.mjs).
const NOTICE_MESSAGE = "factory:notice-token";

/**
 * Parent side: answer `type` requests from `child` with `answer(message)`'s fields, or {error, status, reason,
 * transport, rateLimited}: the last two say GitHub or the network failed for now (github.mjs transientError).
 */
function serve(child, type, answer) {
  child.on("message", (m) => {
    if (m?.type !== type) return;
    const reply = (body) => {
      try {
        child.send({ type, id: m.id, ...body }, () => {});
      } catch {
        // the stage is gone
      }
    };
    Promise.resolve()
      .then(() => answer(m))
      .then(reply, (e) => reply({ error: String(e?.message || e).slice(0, 200), status: Number.isInteger(e?.status) ? e.status : null, reason: typeof e?.reason === "string" ? e.reason.slice(0, 300) : null, transport: e?.transport === true, rateLimited: e?.rateLimited === true }));
  });
}

/** Parent side: answer a stage's notice-token requests with `mint` (noticeMinter). Only the token goes back. */
export function serveNotices(child, mint) {
  serve(child, NOTICE_MESSAGE, () => mint().then((t) => ({ token: t.token })));
}

/** Stage side: `(payload) => reply` from the parent for `type`, or null without an IPC channel. Every token received is pushed onto `issued`. */
function askParent(type, { proc = process, issued = [], timeoutMs = 60_000, what }) {
  if (typeof proc.send !== "function" || !proc.channel) return null;
  proc.channel.unref();
  let n = 0;
  return (payload = {}) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const done = (fn, v) => {
        clearTimeout(timer);
        proc.off("message", on);
        proc.channel?.unref();
        fn(v);
      };
      const on = (m) => {
        if (m?.type !== type || m.id !== id) return;
        if (typeof m.token === "string" && m.token) {
          issued.push(m.token);
          done(resolve, m);
        } else done(reject, Object.assign(new Error(`the parent gave no ${what}: ${m.error || "no reason"}`), { status: m.status ?? undefined, reason: m.reason || undefined, transport: m.transport === true, rateLimited: m.rateLimited === true }));
      };
      // No answer in time: the parent's own call to GitHub is hanging, transient as any other call with no answer.
      const timer = setTimeout(() => done(reject, Object.assign(new Error(`the parent gave no ${what} in time`), { status: 0, transport: true })), timeoutMs);
      proc.on("message", on);
      try {
        proc.send({ ...payload, type, id }, (e) => e && done(reject, new Error(`the parent channel is closed: ${e.message}`)));
      } catch (e) {
        done(reject, new Error(`the parent channel is closed: ${e.message}`));
      }
    });
}

/**
 * Stage side: an async function giving {token} from the parent, or null when this process has no IPC channel (Actions,
 * or a stage started without one). The channel does not keep the stage alive between requests. Every token received is
 * pushed onto `issued` (masking).
 */
export function noticeFromParent({ proc = process, issued = [], timeoutMs = 60_000 } = {}) {
  const ask = askParent(NOTICE_MESSAGE, { proc, issued, timeoutMs, what: "notice token" });
  return ask && (() => ask().then((m) => ({ token: m.token })));
}
