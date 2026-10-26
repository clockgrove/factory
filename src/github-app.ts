/**
 * Factory's own GitHub identity, a GitHub App (docs/reference/setup.md#GitHub identity):
 * its private key, the JWT that authenticates as the App, the permissions
 * Factory needs and the link that registers an App with them. The client
 * (github.ts) mints installation tokens with the JWT, and remote Git
 * (git.ts `remoteToken`) pushes and fetches with them.
 */
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CoreConfig } from "./config.js";
import { remoteToken } from "./git.js";
import { GitHub } from "./github.js";
import { installationPaths } from "./paths.js";
import { writeAtomic } from "./state.js";

/**
 * The App's private key (PEM): the service's credential of this name
 * (LoadCredential), else this environment variable, else the
 * installation's copy that setup keeps (`appKeyFile`). Never in the
 * configuration.
 */
export const GITHUB_APP_KEY = "FACTORY_GITHUB_APP_KEY";

/** Where setup keeps the installation's copy of the App's key (`--github-app-key`), mode 0600. */
export function appKeyFile(root: string): string {
  return join(root, "github-app-key.pem");
}

/**
 * The App's private key, from the first place that has one (GITHUB_APP_KEY);
 * undefined when none does. Throws when one is there but can't be read.
 */
export function appKey(root: string): string | undefined {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  const credential =
    directory && isAbsolute(directory)
      ? join(directory, GITHUB_APP_KEY)
      : undefined;
  if (credential && existsSync(credential))
    return readFileSync(credential, "utf8");
  if (process.env[GITHUB_APP_KEY]) return process.env[GITHUB_APP_KEY];
  const copy = appKeyFile(root);
  return existsSync(copy) ? readFileSync(copy, "utf8") : undefined;
}

/**
 * A JWT that authenticates as App `id` (RS256): issued 60 s in the past for
 * clock drift and expiring 9 min from now, inside GitHub's 10 min limit.
 */
export function appJwt(id: number, key: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: seconds - 60, exp: seconds + 9 * 60, iss: id })}`;
  const signature = sign(
    "sha256",
    Buffer.from(unsigned),
    createPrivateKey(key),
  ).toString("base64url");
  return `${unsigned}.${signature}`;
}

/**
 * What Factory does as the App needs, by GitHub's permission name: its
 * branches, PRs, issues and comments, the checks and runs it waits on, the
 * workflow files a merged base may bring into its branches, and the
 * queue's Project, an organization's (`organization_projects`).
 */
export const APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "read",
  actions: "read",
  workflows: "write",
  metadata: "read",
  statuses: "read",
  organization_projects: "write",
};

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * The APP_PERMISSIONS an installation's `granted` permissions lack, as
 * `name: level`; an organization's Project permission only when the
 * repository's owner is an organization.
 */
export function missingPermissions(
  granted: Readonly<Record<string, string>>,
  organization: boolean,
): string[] {
  return Object.entries(APP_PERMISSIONS)
    .filter(
      ([name, level]) =>
        (organization || name !== "organization_projects") &&
        (LEVEL[granted[name] ?? ""] ?? 0) < LEVEL[level]!,
    )
    .map(([name, level]) => `${name}: ${level}`);
}

/**
 * The link that registers a private GitHub App for `owner` with
 * APP_PERMISSIONS and no webhook (GitHub's registration URL parameters):
 * the organization's settings for an organization, the user's own
 * otherwise. GitHub caps an App's name at 34 characters.
 */
export function appRegistrationLink(
  owner: string,
  organization: boolean,
): string {
  const parameters: Record<string, string> = {
    name: `${owner.slice(0, 26)} Factory`,
    description: `Factory's own identity on ${owner}: it plans, builds, reviews and merges Objectives as this App.`,
    url: "https://github.com/clockgrove/factory",
    public: "false",
    webhook_active: "false",
    ...APP_PERMISSIONS,
  };
  const query = Object.entries(parameters)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
  return `${organization ? `https://github.com/organizations/${owner}/settings/apps/new` : "https://github.com/settings/apps/new"}?${query}`;
}

/** What the operator does with the link (`setup --github-app-link`, readiness). */
export const APP_STEPS =
  "Open it and create the App, generate a private key on its page, install it on the repository, then run factory setup --github-app-id ID --github-app-key PATH";

/** Whether `owner` is an organization, by GitHub's public read of the account (no login). */
export async function organizationOwner(
  owner: string,
  api = "https://api.github.com",
): Promise<boolean> {
  const path = `/users/${encodeURIComponent(owner)}`;
  const response = await fetch(`${api}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub GET ${path}: ${response.status}`);
  const { type } = (await response.json()) as { type?: unknown };
  return type === "Organization";
}

/**
 * The App's private key in `source` (`setup --github-app-key`), checked to
 * load as a private key; throws naming the file, never its content.
 */
export function readAppKey(source: string): string {
  try {
    const key = readFileSync(source, "utf8");
    createPrivateKey(key);
    return key;
  } catch (error) {
    throw new Error(
      `--github-app-key ${source} is not a private key Factory can read (${(error as { code?: unknown }).code ?? "it doesn't load"}); give the .pem file GitHub generated for the App`,
    );
  }
}

/** Keep `key` as the installation's copy (mode 0600); returns whether it changed. */
export function keepAppKey(root: string, key: string): boolean {
  const copy = appKeyFile(root);
  if (existsSync(copy) && readFileSync(copy, "utf8") === key) return false;
  writeAtomic(copy, key);
  return true;
}

/**
 * The client Factory acts through on the configured repository: as its
 * GitHub App when `github.app` is set, remote Git included; otherwise as
 * the GitHub CLI's login (or FACTORY_GITHUB_TOKEN).
 */
export function factoryGitHub(
  config: Pick<CoreConfig, "repository" | "github">,
  api = process.env.FACTORY_GITHUB_API,
): GitHub {
  const app = config.github.app;
  if (!app) return new GitHub(config.repository, api);
  const root = installationPaths(config.repository).root;
  const github = new GitHub(config.repository, api, {
    ...(app.installationId !== undefined && {
      installationId: app.installationId,
    }),
    jwt: () => {
      const key = appKey(root);
      if (!key)
        throw new Error(
          `no private key: give it with factory setup --github-app-key PATH (or ${GITHUB_APP_KEY})`,
        );
      return appJwt(app.id, key);
    },
  });
  remoteToken(config.repository, () => github.serviceToken());
  return github;
}
