// Keep the App's installation token fresh for the length of a job, in memory only. An installation token lives one
// hour; a worker job may run six. The keeper re-mints before expiry; github.mjs reads it through `getter` and Factory's
// own git through outbox.mjs, each per call. No file and no environment variable holds it. Beside it the keeper mints a
// read-only token (a permissions subset of the same installation) for the agent uid on Actions; `onRefresh` hands each
// fresh one over (agent.mjs writes it into the agent's home).
import { mintInstallationToken } from "./app-token.mjs";
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
  }

  /** Mint (unless fixed) and start the refresh timer. */
  async start() {
    if (this.fixed) {
      // A cloud sandbox stage (stage.mjs): the launcher minted both tokens, and the stage's parent hands fresh ones over
      // this process's IPC channel before they expire. Neither is ever in a file or this process's environment.
      if (this.readToken && this.onRefresh) await this.onRefresh(this);
      if (typeof process.send === "function") {
        process.on("message", (m) => {
          if (m?.type !== "factory-tokens" || typeof m.write !== "string" || !m.write) return;
          this.token = m.write;
          this.issued.push(m.write);
          mask(m.write);
          if (typeof m.read === "string" && m.read) {
            this.readToken = m.read;
            this.issued.push(m.read);
            mask(m.read);
          }
          if (this.onRefresh) Promise.resolve().then(() => this.onRefresh(this)).catch((e) => process.stderr.write(`[factory] token hand-over failed: ${e.message}\n`));
        });
        // The channel keeps no process alive on its own: the stage's work does.
        process.channel?.unref?.();
      }
    }
    if (!this.fixed) {
      await this.refresh();
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
    // Factory writes as the App's bot: only its own markers, and people who can push, are trusted (logic.mjs isSelf).
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

  /** For github.mjs calls: always the current token. */
  get getter() {
    return () => this.token;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
