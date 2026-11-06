// Keep the App's installation token fresh for the length of a job. An installation
// token lives one hour; a worker job may run six. The keeper re-mints before expiry
// and rewrites two files the children read on every call instead of a frozen env var:
//   <dir>/token            read by the git credential helper configureGit() installs
//   <dir>/gh/hosts.yml     read by `gh` when GH_CONFIG_DIR=<dir>/gh and GH_TOKEN is unset
// The scripts themselves pass `token: () => keeper.token` to github.mjs.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintInstallationToken } from "./app-token.mjs";
import { mask } from "./inputs.mjs";

export class TokenKeeper {
  constructor({ dir, appId, privateKey, owner, repo, fixedToken = null, refreshMinutes = 40 }) {
    this.dir = dir;
    this.appId = appId;
    this.privateKey = privateKey;
    this.owner = owner;
    this.repo = repo;
    this.token = fixedToken;
    this.issued = fixedToken ? [fixedToken] : []; // every token this job held, for masking the uploaded event log
    this.fixed = !!fixedToken;
    this.refreshMs = refreshMinutes * 60_000;
    this.timer = null;
    this.app = { appSlug: null, missing: [], extra: [] };
    mkdirSync(join(dir, "gh"), { recursive: true });
  }

  /** Mint (unless fixed), write the files, start the refresh timer. */
  async start() {
    if (!this.fixed) await this.refresh();
    else this.write();
    if (!this.fixed) {
      this.timer = setInterval(() => this.refresh().catch((e) => process.stderr.write(`[factory] token refresh failed: ${e.message}\n`)), this.refreshMs);
      this.timer.unref();
    }
    return this;
  }

  async refresh() {
    const minted = await mintInstallationToken({ appId: this.appId, privateKey: this.privateKey, owner: this.owner, repo: this.repo });
    this.token = minted.token;
    this.issued.push(minted.token);
    this.app = minted;
    mask(this.token);
    this.write();
  }

  write() {
    const tokenFile = join(this.dir, "token");
    writeFileSync(tokenFile, `${this.token}\n`);
    chmodSync(tokenFile, 0o600);
    const hosts = join(this.dir, "gh", "hosts.yml");
    // gh's current config format (version 1, users per host), so gh never migrates it: a migration rewrites the
    // file, which a sandbox that keeps this directory read-only (local mode) refuses, and gh then has no login.
    writeFileSync(join(this.dir, "gh", "config.yml"), "version: \"1\"\n");
    writeFileSync(hosts, `github.com:\n    users:\n        x-access-token:\n            oauth_token: ${this.token}\n    git_protocol: https\n    oauth_token: ${this.token}\n    user: x-access-token\n`);
    chmodSync(hosts, 0o600);
  }

  /** The env additions for a child that must act as the App for hours: no GH_TOKEN, gh reads hosts.yml; git reads the token file through the credential helper. */
  childEnv() {
    return { GH_CONFIG_DIR: join(this.dir, "gh"), GH_TOKEN: undefined, GITHUB_TOKEN: undefined };
  }

  /** The git credential helper command that reads the token file on every use. */
  credentialHelper() {
    return `!f() { echo username=x-access-token; echo "password=$(cat ${JSON.stringify(join(this.dir, "token"))})"; }; f`;
  }

  /** For github.mjs calls: always the current token. */
  get getter() {
    return () => this.token;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
