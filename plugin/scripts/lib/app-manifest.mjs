// The Pendulum GitHub App, made from a pre-filled definition with GitHub's App Manifest flow (setup's `app` step,
// #471): https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//
// 1. A listener on 127.0.0.1, on a port the system picks, serves a start page at a random path. The page posts the
//    manifest to GitHub's "new App" form (the user's, or the organization's that owns the repository), with a random
//    `state` in the form's address.
// 2. The user creates the App on GitHub (one click; the name can be edited there). GitHub sends the browser back to the
//    listener's /callback with a one-hour code and the state.
// 3. A redirect whose state is not this run's is refused and the wait goes on. The code is exchanged
//    (POST /app-manifests/{code}/conversions) for the App's id and private key, one redirect at a time; a code that
//    yields no App gives the redirect back. The App is checked to be the one the manifest asked for (its owner, its
//    permissions, no events) before anything is kept.
// 4. The id and key become the PENDULUM_APP_ID and PENDULUM_APP_PRIVATE_KEY secrets through `gh secret set`, each value
//    on the child's stdin: never an argument, a file, the environment or any output. The webhook and client secrets
//    are dropped.
// 5. The browser is sent on to the App's install page.
//
// Before the browser opens, a pre-flight refuses a run whose secrets could not be saved (no gh login, no admin, no
// access to the organization's secrets) or would overwrite ones already there (unless --replace), so no App is made
// that cannot be kept.
//
// Where the browser cannot reach this machine's 127.0.0.1 (a remote shell; WSL with localhost forwarding off), the
// address GitHub sent it to is pasted on stdin instead, or opened from this machine (`curl '<address>'`): the same
// check takes it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { APP_OPTIONAL_PERMISSIONS, APP_PERMISSIONS, PROJECT_PERMISSION_KEYS, permissionGaps } from "./app-token.mjs";
import { rest } from "./github.mjs";
import { holdSecrets } from "./inputs.mjs";
import { exec } from "./proc.mjs";

/** GitHub's longest App name. */
export const APP_NAME_MAX = 34;
/** How long setup waits for GitHub's redirect: inside the hour GitHub gives the whole flow. */
export const REDIRECT_WAIT_MS = 30 * 60_000;
/** The code's exchange, a bound of its own: the redirect's wait ends once a redirect is taken. */
export const EXCHANGE_MS = 60_000;
/** One `gh secret set`. */
export const SECRET_SET_MS = 60_000;
/** At most one "refused a redirect" line this often; the rest are counted into the next. */
export const REFUSED_LINE_MS = 10_000;

/**
 * GitHub's web origin for the API setup talks to: github.com for api.github.com, `<origin>` for a GitHub Enterprise
 * Server's `<origin>/api/v3`. The manifest form, the install page and the App's settings live there. Throws on any
 * other API address: no App is made on one host while its secrets go to another.
 */
export function webOrigin(api = process.env.GITHUB_API_URL || "https://api.github.com") {
  const a = String(api).replace(/\/+$/, "");
  if (a === "https://api.github.com") return "https://github.com";
  const m = /^(https?:\/\/[^/?#]+)\/api\/v3$/.exec(a);
  if (m) return m[1];
  throw new Error(`GITHUB_API_URL ${a} is neither GitHub's API nor a GitHub Enterprise Server's (<origin>/api/v3): there is no web origin to create the App at`);
}

/** gh's env for `web`: GH_HOST names a server other than github.com. */
export const ghEnv = (web, env = process.env) => (new URL(web).host === "github.com" ? env : { ...env, GH_HOST: new URL(web).host });

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

/** The owner's GitHub Apps settings on `web`: the user's own, or the organization's; with `slug`, that App's page. */
export function appsSettingsUrl(web, repoData, slug = "") {
  const base = repoData.owner?.type === "User" ? `${web}/settings/apps` : `${web}/organizations/${encodeURIComponent(repoData.owner.login)}/settings/apps`;
  return slug ? `${base}/${encodeURIComponent(slug)}` : base;
}

/** The form GitHub takes the manifest at: the user's own "new App" page, or the owning organization's. */
export function manifestFormUrl(web, repoData, state) {
  return `${appsSettingsUrl(web, repoData)}/new?state=${encodeURIComponent(state)}`;
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
  "content-security-policy": `default-src 'none'; script-src 'sha256-${createHash("sha256").update(SUBMIT).digest("base64")}'; base-uri 'none'; frame-ancestors 'none'`,
};

/** The start page: the manifest in a form that posts itself to GitHub (a button where scripts are off). */
export function startPage(web, repoData, manifest, state) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Create the Pendulum App</title></head><body>
<p>Creating the GitHub App ${html(manifest.name)} for ${html(repoData.owner.login)} on GitHub, for ${html(repoData.full_name)}.</p>
<form method="post" action="${html(manifestFormUrl(web, repoData, state))}"><input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>
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
  if (typeof app?.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(app.slug)) out.push("no valid slug");
  if (String(app?.owner?.login || "").toLowerCase() !== String(ownerLogin).toLowerCase()) out.push(`its owner is ${app?.owner?.login || "unnamed"}, not ${ownerLogin}`);
  // Doctor's own check of the grant against the one list: nothing missing, nothing beyond it.
  const { missing, extra } = permissionGaps(app?.permissions || {}, { userAccount: !(PROJECT_PERMISSION_KEYS[0] in manifest.default_permissions) });
  if (missing.length) out.push(`it lacks ${missing.join(", ")}`);
  if (extra.length) out.push(`it has ${extra.join(", ")} beyond Pendulum's permissions`);
  if ((app?.events || []).length) out.push(`it subscribes to ${app.events.join(", ")}`);
  return out;
}

/**
 * What a child printed, fit to show: `text` as it is, or, when it holds any line of a secret (8 characters or more) or
 * a whole secret, a notice in its place, so no part of the value is shown, its short last line included.
 */
export function scrub(text, secrets) {
  const t = String(text);
  const parts = secrets.flatMap((v) => [String(v || "").trim(), ...String(v || "").split("\n").map((l) => l.trim())]).filter((l) => l.length >= 8);
  return parts.some((p) => t.includes(p)) ? "(its output held a secret value, so it is not shown)" : t;
}

/**
 * Save `values` ({NAME: value}) as Actions secrets with the user's gh login: the repository's, or with `org` the
 * organization's, shared with this repository alone. Each value goes on gh's stdin. Throws naming the secret that
 * failed and gh's own words, with every value scrubbed from them.
 */
export async function saveSecrets(repo, values, { org = false, env = process.env } = {}) {
  const target = org ? ["--org", repo.owner, "--repos", repo.name] : ["--repo", repo.full];
  const saved = [];
  for (const [name, value] of Object.entries(values)) {
    let r;
    try {
      r = await exec("gh", ["secret", "set", name, ...target], { input: String(value), timeoutMs: SECRET_SET_MS, env });
    } catch (e) {
      throw new Error(`gh secret set ${name} could not start (${e.code === "ENOENT" ? "gh is not on PATH" : e.message})`);
    }
    if (r.code !== 0) throw Object.assign(new Error(`gh secret set ${name} failed (${r.timedOut ? `no answer in ${SECRET_SET_MS / 1000} s` : `exit ${r.code}`}): ${scrub(`${r.stderr}${r.stdout}`, Object.values(values)).trim().slice(0, 300)}`), { saved });
    saved.push(name);
  }
  return saved;
}

/** A secret's record, or null when GitHub has none by that name (404). */
const secretAt = (path) => rest(path).catch((e) => (e.status === 404 ? null : Promise.reject(e)));

/**
 * Why the App's secrets could not be saved, or would overwrite others, as reasons; empty when the step may go on.
 * Read before the browser opens, with the user's gh login:
 * - gh is logged in (`gh auth status`), and the login is an admin of the repository (repoData.permissions);
 * - repository scope: neither secret exists, unless `replace`;
 * - organization scope (`org`): the login can list the organization's secrets; neither secret is shared with any other
 *   repository (saving it for this one would take it from them, `replace` or not); one that serves this repository
 *   alone needs `replace`; and the repository holds no secret of either name, which would win over the organization's.
 */
export async function appPreflight(repo, repoData, { org = false, replace = false, env = process.env } = {}) {
  const out = [];
  const auth = await exec("gh", ["auth", "status"], { timeoutMs: 30_000, env }).catch((e) => ({ code: -1, stderr: e.code === "ENOENT" ? "gh is not on PATH" : e.message }));
  if (auth.code !== 0) return [`gh is not logged in (gh auth status: ${String(auth.stderr || auth.stdout || "").trim().split("\n")[0] || `exit ${auth.code}`}); run gh auth login`];
  if (repoData.permissions?.admin !== true) out.push(`your gh login is no admin of ${repoData.full_name}, and only an admin can save its secrets`);
  const names = Object.values(APP_SECRETS);
  const read = async (what, fn) => {
    try {
      return await fn();
    } catch (e) {
      out.push(`could not read ${what} (${e.status ? `HTTP ${e.status}` : e.message})`);
      return undefined;
    }
  };
  const inRepo = await read(`${repoData.full_name}'s secrets`, async () => (await Promise.all(names.map((n) => secretAt(`repos/${repo.full}/actions/secrets/${n}`)))).map((x, i) => x && names[i]).filter(Boolean));
  if (!org) {
    if (inRepo?.length && !replace) out.push(`${repoData.full_name} already has ${inRepo.join(" and ")}: pass --replace to overwrite them (the App they name keeps its installation; delete it in its settings once the new one works)`);
    return out;
  }
  const o = repoData.owner.login;
  try {
    await rest(`orgs/${o}/actions/secrets?per_page=1`);
  } catch (e) {
    out.push(`your gh login cannot manage ${o}'s organization secrets (${e.status ? `HTTP ${e.status}` : e.message}): an organization owner runs this, or use --secret-scope repo`);
    return out;
  }
  if (inRepo?.length) out.push(`${repoData.full_name} has its own ${inRepo.join(" and ")}, which would win over the organization's: delete them there, or use --secret-scope repo`);
  for (const n of names) {
    const sec = await read(`${o}'s ${n}`, () => secretAt(`orgs/${o}/actions/secrets/${n}`));
    if (!sec) continue;
    if (sec.visibility !== "selected") {
      out.push(`${o}'s ${n} is shared with ${sec.visibility === "all" ? "every repository" : `every ${sec.visibility} repository`} of the organization: saving it for ${repo.name} alone would take it from them; use --secret-scope repo`);
      continue;
    }
    const list = await read(`the repositories ${o}'s ${n} serves`, () => rest(`orgs/${o}/actions/secrets/${n}/repositories?per_page=100`));
    const repos = (list?.repositories || []).map((r) => String(r.full_name || "").toLowerCase());
    const others = repos.filter((r) => r !== repo.full.toLowerCase());
    if (others.length || (list?.total_count ?? 0) > repos.length) out.push(`${o}'s ${n} also serves ${others.join(", ") || "other repositories"}: saving it for ${repo.name} alone would take it from them; use --secret-scope repo`);
    else if (list && !replace) out.push(`${o}'s ${n} already serves ${repoData.full_name}: pass --replace to overwrite it`);
  }
  return out;
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
 * The commands $BROWSER names for `url`, in order: its `:`-separated entries, each an existing file's path (spaces and
 * all), or a command with arguments split on spaces, `%s` replaced by the url, else the url last.
 */
export function browserCommands(value, url) {
  return String(value || "")
    .split(":")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      if (existsSync(entry)) return [entry, [url]];
      const [cmd, ...args] = entry.split(/\s+/);
      return [cmd, args.some((a) => a.includes("%s")) ? args.map((a) => a.split("%s").join(url)) : [...args, url]];
    });
}

/**
 * Open `url` in the user's browser, best effort: $BROWSER's commands when set (browserCommands), else the platform's
 * opener (WSL: wslview, else Windows' explorer.exe). Nothing is waited for and a failure is silent: the address is
 * printed too. No shell runs: `url` is an argument.
 */
export function openBrowser(url, env = process.env) {
  const tries = env.BROWSER
    ? browserCommands(env.BROWSER, url)
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
 * Run the flow for `repoData` and resolve with {appId, slug, installUrl, saved} once the secrets are saved; reject when
 * GitHub's App is refused, a secret fails, or no redirect came within `waitMs`. Once a redirect is taken its wait ends:
 * the exchange has its own bound (`exchangeMs`) and each secret its own (SECRET_SET_MS). An exchange that yields no
 * App gives the redirect back, and the wait goes on. `web` is GitHub's web origin (webOrigin); `say` prints a line;
 * `input` (a readable, default stdin) takes a pasted address; `save` stores the secrets (saveSecrets, with `env`);
 * `signal` (an AbortSignal) stops the flow and its listener.
 */
export async function createAppFromManifest(repo, repoData, { org = false, web = webOrigin(), env = ghEnv(web), say = (l) => process.stdout.write(`${l}\n`), open = openBrowser, input = process.stdin, save = saveSecrets, waitMs = REDIRECT_WAIT_MS, exchangeMs = EXCHANGE_MS, signal = null } = {}) {
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
  const appsList = appsSettingsUrl(web, repoData);
  let taken = false;
  let settled = false;
  let finish;
  const done = new Promise((ok, fail) => (finish = { ok, fail }));
  const end = (fn) => {
    if (!settled) {
      settled = true;
      fn();
    }
  };
  const deadline = Date.now() + waitMs;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => end(() => finish.fail(new Error(`no redirect from GitHub within ${waitMs >= 60_000 ? `${Math.round(waitMs / 60_000)} minutes` : `${waitMs} ms`}; run this step again`))), Math.max(0, deadline - Date.now()));
  };
  let refusedAt = -Infinity;
  let refusedQuiet = 0;
  const refused = (from) => {
    if (Date.now() - refusedAt < REFUSED_LINE_MS) return void (refusedQuiet += 1);
    say(`refused a redirect ${from} whose state is not this run's${refusedQuiet ? ` (and ${refusedQuiet} more since the last such line)` : ""}; still waiting`);
    refusedAt = Date.now();
    refusedQuiet = 0;
  };

  /** One redirect's address, from the browser or pasted: {status, page, location?, refused?, settle?}; `settle` ends the run once the answer is out. */
  const redirect = async (address, from) => {
    let u;
    try {
      u = new URL(address, `http://127.0.0.1:${port}`);
    } catch {
      return { status: 400, page: message("Not an address", "That is not an address.") };
    }
    if (u.pathname !== "/callback") return { status: 404, page: message("Not found", "Nothing here.") };
    if (!sameState(u.searchParams.get("state"), state)) {
      refused(from);
      return { status: 400, refused: true, page: message("Refused", "This redirect does not belong to this setup run: its state does not match. Nothing was saved.") };
    }
    const code = u.searchParams.get("code") || "";
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) return { status: 400, page: message("No code", "GitHub's redirect carries no code.") };
    if (taken || settled) return { status: 409, page: message("Already used", "This setup run already took GitHub's redirect.") };
    taken = true;
    clearTimeout(timer);
    holdSecrets([code]);
    let app;
    try {
      app = await rest(`app-manifests/${code}/conversions`, { method: "POST", deadlineAt: Date.now() + exchangeMs, signal: AbortSignal.timeout(exchangeMs) });
    } catch (e) {
      // No App came back: the redirect is given back and the wait goes on, toward the same deadline.
      taken = false;
      arm();
      const why = `GitHub did not turn the redirect's code into an App (${e.status ? `HTTP ${e.status}` : "no answer"}). If GitHub made one, it is listed at ${appsList}: delete it there (Advanced, Delete GitHub App) before you create another`;
      say(`${why}; still waiting for GitHub's redirect`);
      return { status: 502, page: message("No App", `${why}. This setup run is still waiting.`) };
    }
    holdSecrets([app?.pem, app?.webhook_secret, app?.client_secret]);
    const fail = (status, e) => ({ status, page: message("Setup stopped", e.message), settle: () => end(() => finish.fail(e)) });
    const wrong = appMismatch(app, manifest, repoData.owner.login);
    const settings = wrong.includes("no valid slug") ? appsList : appsSettingsUrl(web, repoData, app.slug);
    if (wrong.length) return fail(500, new Error(`GitHub's App is not the one asked for (${wrong.join("; ")}); nothing was saved. Delete it at ${settings} (Advanced, Delete GitHub App) and run this step again`));
    const installUrl = `${web}/apps/${encodeURIComponent(app.slug)}/installations/new`;
    let saved;
    try {
      saved = await save(repo, { [APP_SECRETS.id]: String(app.id), [APP_SECRETS.key]: app.pem }, { org, env });
    } catch (e) {
      const kept = e.saved?.length ? `; saved ${e.saved.join(", ")}` : "";
      return fail(500, new Error(`${e.message}${kept}. The key is kept nowhere: at ${settings}, Generate a private key, then save it with \`gh secret set ${APP_SECRETS.key} < key.pem\` and the App id ${app.id} with \`gh secret set ${APP_SECRETS.id}\``));
    }
    const result = { appId: app.id, slug: app.slug, installUrl, saved };
    return { status: 302, location: installUrl, page: message("Install the App", `The App is created and its secrets are saved. Install it on ${repoData.full_name}: ${installUrl}`), settle: () => end(() => finish.ok(result)) };
  };

  server.on("request", (req, res) => {
    const send = ({ status, page, location, settle }) => {
      res.writeHead(status, { ...PAGE_HEADERS, ...(location ? { location } : {}) });
      res.end(page, () => settle?.());
    };
    // Only this listener's own names: a page elsewhere that points a name of its own at 127.0.0.1 is turned away.
    if (req.method !== "GET" || !hosts.has(String(req.headers.host || "").toLowerCase())) return send({ status: 400, page: message("Refused", "Refused.") });
    const path = req.url.split("?")[0];
    if (path === startPath) return send({ status: 200, page: startPage(web, repoData, manifest, state) });
    redirect(req.url, "from the browser").then(send, (e) => send({ status: 500, page: message("Setup stopped", e.message), settle: () => end(() => finish.fail(e)) }));
  });

  const start = `http://127.0.0.1:${port}${startPath}`;
  say(`Open ${start} in your browser (opening it now): it sends you to GitHub to create the App ${manifest.name} for ${repoData.owner.login}, signed in as ${repoData.owner.type === "User" ? repoData.owner.login : `an owner or App manager of ${repoData.owner.login}`}.`);
  say(`If the browser then cannot reach 127.0.0.1 (a remote shell, or WSL without localhost forwarding), paste the address it shows here and press Enter, or open it on this machine with curl.`);
  arm();
  signal?.addEventListener("abort", () => end(() => finish.fail(new Error("the app step was stopped"))), { once: true });
  open(start);

  let lines = null;
  if (input && input.readable) {
    lines = createInterface({ input, terminal: false });
    lines.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      redirect(t, "pasted").then(
        (r) => {
          if (r.status === 302) open(r.location);
          else if (r.status !== 500 && r.status !== 502 && !r.refused) say(`that address was not taken (${r.status}): paste the full address GitHub sent the browser to`);
          r.settle?.();
        },
        (e) => end(() => finish.fail(e)),
      );
    });
  }
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    lines?.close();
    if (input === process.stdin) input.destroy();
    server.closeAllConnections();
    server.close();
  }
}
