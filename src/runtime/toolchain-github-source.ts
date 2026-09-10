import type { Octokit } from "@octokit/core";

import { createOctokit } from "../github.js";
import type {
  GitHubRelease,
  GitHubReleaseAsset,
  NodeDistributionIdentity,
  ToolchainReleaseSource,
} from "./toolchain-store.js";

type ReleaseResponse = {
  data: Array<{
    id: number;
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
    assets: Array<{
      id: number;
      name: string;
      url: string;
      browser_download_url: string;
      size: number;
      digest?: string | null;
    }>;
  }>;
};

type AssetResponse = {
  data: Array<{
    id: number;
    name: string;
    url: string;
    browser_download_url: string;
    size: number;
    digest?: string | null;
  }>;
};

function releaseAsset(asset: AssetResponse["data"][number]): GitHubReleaseAsset {
  return {
    id: asset.id,
    name: asset.name,
    url: asset.url,
    browserDownloadUrl: asset.browser_download_url,
    size: asset.size,
    digest: asset.digest ?? "",
  };
}

/** GitHub release acquisition stays on Factory's shared Octokit transport. */
export class OctokitToolchainReleaseSource implements ToolchainReleaseSource {
  readonly #token: string;
  readonly #clients = new Map<string, Octokit>();

  constructor(token: string) {
    this.#token = token;
  }

  #client(owner: string, repository: string): Octokit {
    const key = `${owner}/${repository}`;
    let client = this.#clients.get(key);
    if (!client) {
      client = createOctokit({ token: this.#token, owner, repo: repository });
      this.#clients.set(key, client);
    }
    return client;
  }

  async listReleases(owner: string, repository: string): Promise<GitHubRelease[]> {
    const response = (await this.#client(owner, repository).request(
      "GET /repos/{owner}/{repo}/releases",
      { owner, repo: repository, per_page: 50 },
    )) as ReleaseResponse;
    return response.data.map((release) => ({
      id: release.id,
      tag: release.tag_name,
      draft: release.draft,
      prerelease: release.prerelease,
      publishedAt: release.published_at ?? "1970-01-01T00:00:00.000Z",
      assets: release.assets.map(releaseAsset),
    }));
  }

  async listReleaseAssets(
    owner: string,
    repository: string,
    releaseId: number,
  ): Promise<GitHubReleaseAsset[]> {
    const assets: GitHubReleaseAsset[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const response = (await this.#client(owner, repository).request(
        "GET /repos/{owner}/{repo}/releases/{release_id}/assets",
        { owner, repo: repository, release_id: releaseId, per_page: 100, page },
      )) as AssetResponse;
      assets.push(...response.data.map(releaseAsset));
      if (response.data.length < 100) return assets;
    }
    throw new Error("GitHub release asset listing exceeds the supported pagination bound");
  }

  async downloadAsset(owner: string, repository: string, assetId: number): Promise<Buffer> {
    const response = (await this.#client(owner, repository).request(
      "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
      {
        owner,
        repo: repository,
        asset_id: assetId,
        headers: { accept: "application/octet-stream" },
      },
    )) as { data: unknown };
    if (response.data instanceof ArrayBuffer) return Buffer.from(response.data);
    if (ArrayBuffer.isView(response.data))
      return Buffer.from(response.data.buffer, response.data.byteOffset, response.data.byteLength);
    if (typeof response.data === "string") return Buffer.from(response.data, "binary");
    throw new Error("GitHub release asset response was not binary data");
  }

  async resolveLatestNodeDistribution(): Promise<NodeDistributionIdentity> {
    const indexResponse = await fetch("https://nodejs.org/dist/index.json", {
      headers: { accept: "application/json" },
    });
    if (!indexResponse.ok) throw new Error("official Node release index request failed");
    const indexText = await indexResponse.text();
    if (Buffer.byteLength(indexText) > 2 * 1024 * 1024)
      throw new Error("official Node release index exceeds the supported bound");
    const index = JSON.parse(indexText) as Array<{
      version?: unknown;
      date?: unknown;
      files?: unknown;
    }>;
    if (!Array.isArray(index)) throw new Error("official Node release index is malformed");
    const releases = index.flatMap((candidate) => {
      const { version, date, files } = candidate;
      const match = typeof version === "string" ? /^v(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
      return match &&
        typeof date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Array.isArray(files) &&
        files.includes("linux-x64")
        ? [{ ...candidate, version, date, semver: match.slice(1).map(Number) }]
        : [];
    });
    releases.sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = right.semver[index]! - left.semver[index]!;
        if (difference !== 0) return difference;
      }
      return right.date < left.date ? -1 : right.date > left.date ? 1 : 0;
    });
    const release = releases[0];
    if (!release || typeof release.version !== "string" || typeof release.date !== "string")
      throw new Error("official Node release index has no Linux x64 GA");
    const name = `node-${release.version}-linux-x64.tar.xz`;
    const shasumsUrl = `https://nodejs.org/dist/${release.version}/SHASUMS256.txt`;
    const shasumsResponse = await fetch(shasumsUrl, { headers: { accept: "text/plain" } });
    if (!shasumsResponse.ok) throw new Error("official Node checksum request failed");
    const shasums = await shasumsResponse.text();
    if (Buffer.byteLength(shasums) > 512 * 1024)
      throw new Error("official Node checksum document exceeds the supported bound");
    const matches = shasums.split(/\r?\n/).flatMap((line) => {
      const match = /^([a-f0-9]{64})\s{2}([^\s]+)$/.exec(line);
      return match?.[2] === name ? [match[1]!] : [];
    });
    if (matches.length !== 1) throw new Error("official Node checksum is missing or ambiguous");
    return {
      version: release.version.slice(1),
      tag: release.version,
      publishedAt: `${release.date}T00:00:00.000Z`,
      name,
      url: `https://nodejs.org/dist/${release.version}/${name}`,
      sha256: matches[0]!,
      archive: "tar.xz",
      executablePath: `node-${release.version}-linux-x64/bin/node`,
    };
  }

  async downloadNodeDistribution(identity: NodeDistributionIdentity): Promise<Buffer> {
    const response = await fetch(identity.url, { headers: { accept: "application/octet-stream" } });
    if (!response.ok) throw new Error("official Node distribution request failed");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 512 * 1024 * 1024)
      throw new Error("official Node distribution exceeds the supported bound");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 512 * 1024 * 1024)
      throw new Error("official Node distribution exceeds the supported bound");
    return bytes;
  }
}
