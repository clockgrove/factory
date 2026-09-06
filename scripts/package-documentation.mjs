import { posix } from "node:path";

export const operatorDocumentation = Object.freeze([
  "docs/CREDENTIALS.md",
  "docs/HOST-SCHEDULING.md",
  "docs/THREAT-MODEL.md",
  "docs/setup/README.md",
  "docs/setup/codex-app-server.md",
  "docs/setup/configuration.md",
  "docs/setup/daytona.md",
  "docs/setup/github-managed.md",
  "docs/setup/local.md",
  "docs/setup/unattended.md",
  "docs/setup/vercel-sandbox.md",
]);

/** Inspect actual package paths and Markdown bytes, never the development tree. */
export function assertPackageDocumentation(packagePaths, documents) {
  const paths = new Set(packagePaths);
  for (const required of [
    "README.md", "SECURITY.md", "SUPPORT.md", "CHANGELOG.md", ...operatorDocumentation,
  ]) {
    if (!paths.has(required)) {
      throw new Error(`npm package is missing operator documentation ${required}`);
    }
  }
  for (const path of paths) {
    if (path.startsWith("docs/") && !operatorDocumentation.includes(path)) {
      throw new Error(`npm package includes non-operator documentation ${path}`);
    }
    if (!path.endsWith(".md")) continue;
    if (typeof documents[path] !== "string") {
      throw new Error(`npm package Markdown was not inspected: ${path}`);
    }
    // Inline links/images and reference definitions cover the shipped Markdown.
    // Fragment anchors stay within a file; this check guards distributed file targets.
    const destinations = [
      ...documents[path].matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g),
      ...documents[path].matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm),
    ];
    for (const match of destinations) {
      const href = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
      const target = decodeURIComponent(href.split(/[?#]/)[0]);
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (
        !target || target.startsWith("/") || target.includes("\\") ||
        resolved.startsWith("../") || !paths.has(resolved)
      ) {
        throw new Error(`npm package Markdown link has no packaged target: ${path} -> ${href}`);
      }
    }
  }
}
