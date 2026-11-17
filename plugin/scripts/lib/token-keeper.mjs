// Keep the App's installation token fresh for the length of a job, in memory only. An installation token lives one
// hour; a worker job may run six. The keeper re-mints before expiry; github.mjs reads it through `getter` and Pendulum's
// own git through outbox.mjs, each per call, and a call GitHub refuses with 401 has it re-minted once (#405). No file
// and no environment variable holds it. Beside it the keeper mints a read-only token (a permissions subset of the same
// installation) for the agent uid on Actions; `onRefresh` hands each fresh one over (agent.mjs writes it into the
// agent's home, each file replaced whole).
import { mintInstallationToken } from "./app-token.mjs";
import { githubNow } from "./github.mjs";
import { mask } from "./inputs.mjs";
import { setSelf } from "./logic.mjs";

/** What the agent may read: the code, the issue and PR, checks and statuses; never a write. */
export const READ_PERMISSIONS = { contents: "read", issues: "read", pull_requests: "read", checks: "read", statuses: "read", metadata: "read" };

export class TokenKeeper {
  constructor({ appId, privateKey, owner, repo, fixedToken = null, fixedReadToken = null, refreshMinutes = 40, readToken = false, onRefresh = null }) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.owner = owner;
    this.repo = repo;
    this.token = fixedToken;
    this.readToken = fixedReadToken;
    this.wantRead = readToken;
    this.onRefresh = onRefresh;
    this.issued = [fixedToken, fixedReadToken].filter(Boolean); // every token this job held, for masking the uploaded event log
    this.fixed = !!fixedToken;
    this.refreshMs = refreshMinutes * 60_000;
    this.timer = null;
    this.app = { appSlug: null, missing: [], extra: [] };
    // When the write token expires (GitHub's expires_at, ms on GitHub's clock) and when GitHub answered its mint (ms, this
    // machine's clock), once minted here; the mint in flight, shared (refresh).
    this.expiresAt = null;
    this.mintedAt = null;
    this.minting = null;
  }

  /** Mint (unless fixed) and start the refresh timer. */
  async start() {
    if (this.fixed) {
      // A cloud sandbox stage (stage.mjs): the launcher minted both tokens, and the stage's parent hands fresh ones over
      // this process's IPC channel before they expire. Neither is ever in a file or this process's environment.
      if (this.readToken && this.onRefresh) await this.onRefresh(this);
      if (typeof process.send === "function") {
        process.on("message", (m) => {
          if (m?.type !== "pendulum-tokens" || typeof m.write !== "string" || !m.write) return;
          this.token = m.write;
          this.issued.push(m.write);
          mask(m.write);
          if (typeof m.read === "string" && m.read) {
            this.readToken = m.read;
            this.issued.push(m.read);
            mask(m.read);
          }
          if (this.onRefresh) Promise.resolve().then(() => this.onRefresh(this)).catch((e) => process.stderr.write(`[pendulum] token hand-over failed: ${e.message}\n`));
        });
        // The channel keeps no process alive on its own: the stage's work does.
        process.channel?.unref?.();
      }
    }
    if (!this.fixed) {
      await this.refresh();
      this.timer = setInterval(() => this.refresh().catch((e) => process.stderr.write(`[pendulum] token refresh failed: ${e.message}\n`)), this.refreshMs);
      this.timer.unref();
    }
    return this;
  }

  /**
   * Mint both tokens now: one mint at a time, shared by every caller asking meanwhile (the timer, a call's 401). The write
   * token is replaced as soon as it is minted: a failure after (the read-only token, `onRefresh`) rejects, with the new
   * write token already in use.
   */
  refresh() {
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  async mint() {
    const minted = await mintInstallationToken({ appId: this.appId, privateKey: this.privateKey, owner: this.owner, repo: this.repo });
    this.token = minted.token;
    this.mintedAt = Date.now();
    const expires = Date.parse(minted.expiresAt);
    this.expiresAt = Number.isFinite(expires) ? expires : null;
    this.issued.push(minted.token);
    this.app = minted;
    // Pendulum writes as the App's bot: only its own markers, and people who can push, are trusted (logic.mjs isSelf).
    if (minted.appSlug) setSelf(`${minted.appSlug}[bot]`);
    mask(this.token);
    if (this.wantRead) {
      // Only the read permissions the installation has: asking for one it lacks is refused.
      const granted = minted.permissions || {};
      const permissions = Object.fromEntries(Object.entries(READ_PERMISSIONS).filter(([k]) => granted[k] && granted[k] !== "none"));
      const read = await mintInstallationToken({ appId: this.appId, privateKey: this.privateKey, owner: this.owner, repo: this.repo, permissions });
      const wrote = Object.entries(read.permissions || {}).filter(([, v]) => v === "write" || v === "admin");
      if (wrote.length) throw new Error(`the agent's token came back with write access (${wrote.map(([k]) => k).join(", ")}); refusing to hand it over`);
      this.readToken = read.token;
      this.issued.push(read.token);
      mask(read.token);
    }
    if (this.onRefresh) await this.onRefresh(this);
  }

  /**
   * For github.mjs calls: always the current token. A minted one (not a fixed one, which only its giver renews) can be
   * refreshed by the call (`refresh`, after GitHub's 401), says when it was minted (`mintedAt`, for GitHub's delay with a
   * new token) and when it is at or within a minute of its expiry on GitHub's clock (`expired`), so no call goes with it then.
   */
  get getter() {
    const get = () => this.token;
    if (!this.fixed) {
      get.refresh = () => this.refresh();
      get.mintedAt = (token) => (token && token === this.token ? this.mintedAt : null);
      get.expired = () => this.expiresAt !== null && this.expiresAt - githubNow() < 60_000;
    }
    return get;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
