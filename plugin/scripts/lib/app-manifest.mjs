// The Pendulum GitHub App, made from a pre-filled definition with GitHub's App Manifest flow (setup's `app` step,
// #471): https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//
// 1. A listener on 127.0.0.1, on a port the system picks, serves a start page at a random path. The page posts the
//    manifest to GitHub's "new App" form (the user's, or the organization's that owns the repository), with a random
//    `state` in the form's address.
// 2. The user creates the App on GitHub (one click; the name can be edited there). GitHub sends the browser back to the
//    listener's /callback with a one-hour code and the state.
// 3. A redirect whose state is not this run's is refused and the wait goes on. The code is exchanged once
//    (POST /app-manifests/{code}/conversions) for the App's id and private key; the App is checked to be exactly the
//    one the manifest asked for (its owner, its permissions, no events) before anything is kept.
// 4. The id and key become the PENDULUM_APP_ID and PENDULUM_APP_PRIVATE_KEY secrets through `gh secret set`, each value
//    on the child's stdin: never an argument, a file, the environment or any output. The webhook and client secrets
//    are dropped.
// 5. The browser is sent on to the App's install page.
//
// Where the browser cannot reach this machine's 127.0.0.1 (a remote shell; WSL with localhost forwarding off), the
// address GitHub sent it to is pasted on stdin instead, or opened from this machine (`curl '<address>'`): the same
// check takes it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { APP_OPTIONAL_PERMISSIONS, APP_PERMISSIONS, PROJECT_PERMISSION_KEYS, permissionGaps } from "./app-token.mjs";
import { rest } from "./github.mjs";
import { holdSecrets } from "./inputs.mjs";
import { exec } from "./proc.mjs";

/** GitHub's web origin: the manifest form and the install page. Never an API call. */
export const GITHUB_WEB = "https://github.com";
/** GitHub's longest App name. */
export const APP_NAME_MAX = 34;
/** How long setup waits for GitHub's redirect: inside the hour GitHub gives the whole flow. */
export const REDIRECT_WAIT_MS = 30 * 60_000;
/** The secret names the workflow passes to the Action. */
export const APP_SECRETS = { id: "PENDULUM_APP_ID", key: "PENDULUM_APP_PRIVATE_KEY" };

/**
 * The App's permissions, from the one list doctor and setup check (app-token.mjs): APP_PERMISSIONS, the optional
 * actions read, and Projects (an organization permission) on an organization's App only; never workflows.
 */
export function manifestPermissions({ userAccount = false } = {}) {
  return { ...APP_PERMISSIONS, ...APP_OPTIONAL_PERMISSIONS, ...(userAccount ? {} : { [PROJECT_PERMISSION_KEYS[0]]: "write" }) };
}

/** "Pendulum (<repo>)", the repository's name cut to fit GitHub's limit. */
export const appName = (repoName) => `Pendulum (${String(repoName).slice(0, APP_NAME_MAX - "Pendulum ()".length)})`;

/**
 * The manifest for `repoData` (GitHub's repository record): the App named for it, its homepage the repository, its
 * webhook inactive and subscribed to no event, private to its owner, the permissions above, and GitHub's redirect to
 * `redirectUrl`.
 */
export function appManifest(repoData, redirectUrl) {
  const userAccount = repoData.owner?.type === "User";
  return {
    name: appName(repoData.name),
    url: repoData.html_url,
    description: `Clockgrove Pendulum for ${repoData.full_name}: pushes, pull requests, labels and the board, for this one repository.`,
    hook_attributes: { url: repoData.html_url, active: false },
    redirect_url: redirectUrl,
    public: false,
    default_events: [],
    default_permissions: manifestPermissions({ userAccount }),
    request_oauth_on_install: false,
  };
}

/** The form GitHub takes the manifest at: the user's own "new App" page, or the owning organization's. */
export function manifestFormUrl(repoData, state) {
  const where = repoData.owner?.type === "User" ? "settings/apps/new" : `organizations/${encodeURIComponent(repoData.owner.login)}/settings/apps/new`;
  return `${GITHUB_WEB}/${where}?state=${encodeURIComponent(state)}`;
}

const html = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SUBMIT = "document.forms[0].submit();";
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // The page runs its one submit script and loads nothing. No form-action: browsers apply it to the redirects after the
  // post too, and GitHub may send an organization's member through its single sign-on elsewhere first.
  "content-security-policy": `default-src 'none'; script-src 'sha256-${createHash("sha256").update(SUBMIT).digest("base64")}'; base-uri 'none'`,
};

/** The start page: the manifest in a form that posts itself to GitHub (a button where scripts are off). */
export function startPage(repoData, manifest, state) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Create the Pendulum App</title></head><body>
<p>Creating the GitHub App ${html(manifest.name)} for ${html(repoData.owner.login)} on GitHub, for ${html(repoData.full_name)}.</p>
<form method="post" action="${html(manifestFormUrl(repoData, state))}"><input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>
<script>${SUBMIT}</script></body></html>`;
}

const message = (title, text) => `<!doctype html><html><head><meta charset="utf-8"><title>${html(title)}</title></head><body><p>${html(text)}</p></body></html>`;

/** Whether `got` is `want`, compared in constant time. */
function sameState(got, want) {
  const a = Buffer.from(String(got ?? ""));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What GitHub's conversion answer lacks of the App the manifest asked for, as reasons: another owner, a permission
 * missing from the shared list or beyond it (app-token.mjs permissionGaps), any event, no id or key. Empty when it is
 * that App.
 */
export function appMismatch(app, manifest, ownerLogin) {
  const out = [];
  if (!Number.isSafeInteger(app?.id) || app.id <= 0) out.push("no App id");
  if (typeof app?.pem !== "string" || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(app.pem.trim())) out.push("no private key");
  if (String(app?.owner?.login || "").toLowerCase() !== String(ownerLogin).toLowerCase()) out.push(`its owner is ${app?.owner?.login || "unnamed"}, not ${ownerLogin}`);
  // Doctor's own check of the grant against the one list: nothing missing, nothing beyond it.
  const { missing, extra } = permissionGaps(app?.permissions || {}, { userAccount: !(PROJECT_PERMISSION_KEYS[0] in manifest.default_permissions) });
  if (missing.length) out.push(`it lacks ${missing.join(", ")}`);
  if (extra.length) out.push(`it has ${extra.join(", ")} beyond Pendulum's permissions`);
  if ((app?.events || []).length) out.push(`it subscribes to ${app.events.join(", ")}`);
  return out;
}

/** `text` with every line of each secret (8 characters or more) replaced by ***: what a child printed, before it is shown. */
export function scrub(text, secrets) {
  const parts = secrets.flatMap((s) => String(s || "").split("\n")).map((l) => l.trim()).filter((l) => l.length >= 8).sort((a, b) => b.length - a.length);
  return parts.reduce((t, p) => t.split(p).join("***"), String(text));
}

/**
 * Save `values` ({NAME: value}) as Actions secrets with the user's gh login: the repository's, or with `org` the
 * organization's, shared with this repository alone. Each value goes on gh's stdin. Throws naming the secret that
 * failed and gh's own words, with every value scrubbed from them.
 */
export async function saveSecrets(repo, values, { org = false } = {}) {
  const target = org ? ["--org", repo.owner, "--repos", repo.name] : ["--repo", repo.full];
  const saved = [];
  for (const [name, value] of Object.entries(values)) {
    let r;
    try {
      r = await exec("gh", ["secret", "set", name, ...target], { input: String(value), timeoutMs: 60_000 });
    } catch (e) {
      throw new Error(`gh secret set ${name} could not start (${e.code === "ENOENT" ? "gh is not on PATH" : e.message})`);
    }
    if (r.code !== 0) throw Object.assign(new Error(`gh secret set ${name} failed (exit ${r.code}): ${scrub(`${r.stderr}${r.stdout}`, Object.values(values)).trim().slice(0, 300)}`), { saved });
    saved.push(name);
  }
  return saved;
}

/** Whether this is WSL, where the browser is Windows' own. */
const isWsl = (env) => !!env.WSL_DISTRO_NAME || (() => {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
})();

/**
 * Open `url` in the user's browser, best effort: $BROWSER when set (its first entry), else the platform's opener (WSL:
 * wslview, else Windows' explorer.exe). Nothing is waited for and a failure is silent: the address is printed too.
 * `url` is always one of the listener's own addresses or GitHub's install page, with no character a shell reads.
 */
export function openBrowser(url, env = process.env) {
  const browser = String(env.BROWSER || "").split(":")[0].trim();
  const tries = browser
    ? [[browser, [url]]]
    : process.platform === "darwin"
      ? [["open", [url]]]
      : isWsl(env)
        ? [["wslview", [url]], ["explorer.exe", [url]]]
        : [["xdg-open", [url]]];
  const next = (i) => {
    if (i >= tries.length) return;
    try {
      const c = spawn(tries[i][0], tries[i][1], { stdio: "ignore", detached: true, env });
      c.on("error", () => next(i + 1));
      c.unref();
    } catch {
      next(i + 1);
    }
  };
  next(0);
}

/**
 * Run the flow for `repoData` and resolve with {appId, slug, htmlUrl, installUrl, saved} once the secrets are saved;
 * reject when GitHub's answer is refused, a secret fails, or no redirect came within `waitMs`. `say` prints a line;
 * `input` (a readable, default stdin) takes a pasted address; `save` stores the secrets (saveSecrets).
 */
export async function createAppFromManifest(repo, repoData, { org = false, say = (l) => process.stdout.write(`${l}\n`), open = openBrowser, input = process.stdin, save = saveSecrets, waitMs = REDIRECT_WAIT_MS } = {}) {
  const state = randomBytes(24).toString("hex");
  const startPath = `/${randomBytes(24).toString("hex")}`;
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const { port } = server.address();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const manifest = appManifest(repoData, `http://127.0.0.1:${port}/callback`);
  let taken = false;
  let finish;
  const done = new Promise((ok, fail) => (finish = { ok, fail }));

  /** One redirect's address, from the browser or pasted: {status, page, location?}. */
  const redirect = async (address, from) => {
    let u;
    try {
      u = new URL(address, `http://127.0.0.1:${port}`);
    } catch {
      return { status: 400, page: message("Not an address", "That is not an address.") };
    }
    if (u.pathname !== "/callback") return { status: 404, page: message("Not found", "Nothing here.") };
    if (!sameState(u.searchParams.get("state"), state)) {
      say(`refused a redirect ${from} whose state is not this run's; still waiting`);
      return { status: 400, refused: true, page: message("Refused", "This redirect does not belong to this setup run: its state does not match. Nothing was saved.") };
    }
    const code = u.searchParams.get("code") || "";
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) return { status: 400, page: message("No code", "GitHub's redirect carries no code.") };
    if (taken) return { status: 409, page: message("Already used", "This setup run already took GitHub's redirect.") };
    taken = true;
    holdSecrets([code]);
    try {
      const result = await convert(code);
      finish.ok(result);
      return { status: 302, location: result.installUrl, page: message("Install the App", `The App is created and its secrets are saved. Install it on ${repoData.full_name}: ${result.installUrl}`) };
    } catch (e) {
      finish.fail(e);
      return { status: 500, page: message("Setup stopped", e.message) };
    }
  };

  const convert = async (code) => {
    let app;
    try {
      app = await rest(`app-manifests/${code}/conversions`, { method: "POST" });
    } catch (e) {
      throw new Error(`GitHub did not turn the redirect's code into the App (${e.status ? `HTTP ${e.status}` : "no answer"}); if GitHub created it, delete it in its settings and run this step again`);
    }
    holdSecrets([app?.pem, app?.webhook_secret, app?.client_secret]);
    const wrong = appMismatch(app, manifest, repoData.owner.login);
    if (wrong.length) throw new Error(`GitHub's App is not the one asked for (${wrong.join("; ")}); nothing was saved. Delete it${app?.html_url ? ` at ${app.html_url}` : ""} and run this step again`);
    const installUrl = `${GITHUB_WEB}/apps/${encodeURIComponent(app.slug)}/installations/new`;
    try {
      const saved = await save(repo, { [APP_SECRETS.id]: String(app.id), [APP_SECRETS.key]: app.pem }, { org });
      return { appId: app.id, slug: app.slug, htmlUrl: app.html_url, installUrl, saved };
    } catch (e) {
      const kept = e.saved?.length ? `; saved ${e.saved.join(", ")}` : "";
      throw new Error(`${e.message}${kept}. The key is not kept anywhere: generate a new private key at ${app.html_url} and save it with \`gh secret set ${APP_SECRETS.key} < key.pem\` (and the id ${app.id} as ${APP_SECRETS.id})`);
    }
  };

  server.on("request", (req, res) => {
    const send = ({ status, page, location }) => {
      res.writeHead(status, { ...PAGE_HEADERS, ...(location ? { location } : {}) });
      res.end(page);
    };
    // Only this listener's own names: a page elsewhere that points a name of its own at 127.0.0.1 is turned away.
    if (req.method !== "GET" || !hosts.has(String(req.headers.host || "").toLowerCase())) return send({ status: 400, page: message("Refused", "Refused.") });
    const path = req.url.split("?")[0];
    if (path === startPath) return send({ status: 200, page: startPage(repoData, manifest, state) });
    redirect(req.url, "from the browser").then(send, (e) => send({ status: 500, page: message("Setup stopped", e.message) }));
  });

  const start = `http://127.0.0.1:${port}${startPath}`;
  say(`Open ${start} in your browser (opening it now): it sends you to GitHub to create the App ${manifest.name} for ${repoData.owner.login}, signed in as ${repoData.owner.type === "User" ? repoData.owner.login : `an owner or App manager of ${repoData.owner.login}`}.`);
  say(`If the browser then cannot reach 127.0.0.1 (a remote shell, or WSL without localhost forwarding), paste the address it shows here and press Enter, or open it on this machine with curl.`);
  open(start);

  let lines = null;
  if (input && input.readable) {
    lines = createInterface({ input, terminal: false });
    lines.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      redirect(t, "pasted").then((r) => {
        if (r.status === 302) open(r.location);
        else if (r.status !== 500 && !r.refused) say(`that address was not taken (${r.status}): paste the full address GitHub sent the browser to`);
      });
    });
  }
  const timer = setTimeout(() => finish.fail(new Error(`no redirect from GitHub within ${Math.round(waitMs / 60_000)} minutes; run this step again`)), waitMs);
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    lines?.close();
    if (input === process.stdin) input.destroy();
    // Let the redirect's answer (the install page) reach the browser before the listener goes.
    await new Promise((r) => setTimeout(r, 200));
    server.closeAllConnections();
    server.close();
  }
}
