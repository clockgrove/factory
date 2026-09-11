import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { afterAll } from "vitest";

import { provisionToolchain } from "../src/runtime/toolchain-store.js";
import { enterTemporaryNamespace } from "./helpers/temporary-namespace.js";

// Setup files run before each test file. Independent workers and repeated runs
// must not share the user's bounded pending-transfer or content caches.
const namespace = enterTemporaryNamespace();
const previousXdgDataHome = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = join(namespace.root, "xdg-data");

// Offline tests run against an isolated, receipt-backed pnpm installation. The
// executable delegates to the package used by this source checkout; production
// provisioning still requires official release metadata and bytes.
const require = createRequire(import.meta.url);
const pnpmRoot = dirname(require.resolve("pnpm"));
const wrapper = Buffer.from(
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(pnpmRoot, "bin/pnpm.cjs"))} "$@"\n`,
  "utf8",
);
const nodeWrapper = Buffer.from(
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  "utf8",
);
await provisionToolchain("pnpm", {
  source: {
    listReleases: async () => [
      {
        id: 1,
        tag: "v10.34.5",
        draft: false,
        prerelease: false,
        publishedAt: "2026-09-10T00:00:00.000Z",
        assets: [
          {
            id: 1,
            name: "pnpm-linux-x64",
            url: "test://pnpm-release-asset",
            browserDownloadUrl:
              "https://github.com/pnpm/pnpm/releases/download/v10.34.5/pnpm-linux-x64",
            size: wrapper.byteLength,
            digest: `sha256:${await crypto.subtle
              .digest("SHA-256", wrapper)
              .then((value) => Buffer.from(value).toString("hex"))}`,
          },
        ],
      },
    ],
    downloadAsset: async () => wrapper,
    resolveLatestNodeDistribution: async () => ({
      version: process.version.slice(1),
      tag: process.version,
      publishedAt: "2026-09-10T00:00:00.000Z",
      name: `node-${process.version}-linux-x64-test`,
      url: `https://nodejs.org/dist/${process.version}/node-${process.version}-linux-x64-test`,
      sha256: await crypto.subtle
        .digest("SHA-256", nodeWrapper)
        .then((value) => Buffer.from(value).toString("hex")),
      archive: "raw",
      executablePath: "node",
    }),
    downloadNodeDistribution: async () => nodeWrapper,
  },
  run: (async (command: string) => ({
    stdout: command.includes("/node/root/") ? `${process.version}\n` : "10.34.5\n",
    stderr: "",
  })) as never,
});

afterAll(() => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  namespace.restore();
});
