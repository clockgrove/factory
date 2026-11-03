// Mint a short-lived installation token from the adopter's Factory GitHub App.
// Node's crypto signs the RS256 JWT, so no dependency and no extra action is
// needed; the same code serves the Action and `/factory doctor` on a laptop.
// Factory never creates an App; it only verifies and uses the one it is given.
import { createSign } from "node:crypto";

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
  const r = await fetch(`${API}/${path.replace(/^\//, "")}`, {
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
    throw e;
  }
  return json;
}

export const WANTED_PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write" };
/** Projects v2 is granted by the App's org/user "projects" permission; the installation reports it as `organization_projects`. */
export const PROJECT_PERMISSION_KEYS = ["organization_projects", "projects"];

/**
 * Mint an installation token scoped to one repository. Returns
 * {token, expiresAt, permissions, installationId, appSlug, extra}, where `extra`
 * lists granted permissions beyond the four Factory needs (doctor warns on them).
 */
export async function mintInstallationToken({ appId, privateKey, owner, repo }) {
  if (!appId || !privateKey) throw new Error("app_id and app_private_key are required");
  const jwt = appJwt(appId, privateKey);
  const app = await api("app", { token: jwt });
  const inst = await api(`repos/${owner}/${repo}/installation`, { token: jwt });
  const granted = inst.permissions || {};
  const tok = await api(`app/installations/${inst.id}/access_tokens`, { token: jwt, method: "POST", body: { repositories: [repo] } });
  const perms = tok.permissions || granted;
  const needed = new Set([...Object.keys(WANTED_PERMISSIONS), ...PROJECT_PERMISSION_KEYS, "metadata"]);
  const extra = Object.entries(perms)
    .filter(([k, v]) => !needed.has(k) && v && v !== "none")
    .map(([k, v]) => `${k}:${v}`);
  const missing = Object.entries(WANTED_PERMISSIONS)
    .filter(([k, v]) => !(perms[k] === v || (v === "read" && perms[k] === "write")))
    .map(([k, v]) => `${k}:${v}`);
  if (!PROJECT_PERMISSION_KEYS.some((k) => perms[k] === "write")) missing.push("projects:write");
  return { token: tok.token, expiresAt: tok.expires_at, permissions: perms, installationId: inst.id, appSlug: app.slug, appName: app.name, extra, missing };
}
