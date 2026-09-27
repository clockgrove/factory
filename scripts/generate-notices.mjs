import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
);
const production = Object.entries(lock.packages)
  .filter(([path, entry]) => path && !entry.dev)
  .map(([path, entry]) => ({
    path,
    name: path.slice(
      path.lastIndexOf("node_modules/") + "node_modules/".length,
    ),
    version: entry.version,
    license: entry.license,
    optional: Boolean(entry.optional),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

if (!production.length || production.some((entry) => !entry.license)) {
  throw new Error("Production dependency licenses must be known");
}
const apache = readFileSync(
  resolve(root, "node_modules/@openai/codex-sdk/LICENSE"),
  "utf8",
).trimEnd();
if (!apache.includes("Apache License") || !apache.includes("Version 2.0")) {
  throw new Error("Installed SDK license text is not Apache-2.0");
}
const anthropicAgentLicense = readFileSync(
  resolve(root, "node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md"),
  "utf8",
).trimEnd();
const githubCopilotLicense = readFileSync(
  resolve(root, "licenses/GitHub-Copilot-SDK-MIT.txt"),
  "utf8",
).trimEnd();
const koffiLicense = readFileSync(
  resolve(root, "node_modules/koffi/LICENSE.txt"),
  "utf8",
).trimEnd();

function noticesFor(entry) {
  const directory = resolve(root, entry.path);
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) =>
          /^(license|licence|copying|notice)([-._]|$)/i.test(name),
        )
        .filter((name) => statSync(resolve(directory, name)).isFile())
        .sort()
    : [];
  if (files.length)
    return files.map((name) => ({
      source: `${entry.path}/${name}`,
      text: readFileSync(resolve(directory, name), "utf8")
        .replace(/\r\n?/g, "\n")
        .trimEnd(),
    }));
  if (entry.license === "Apache-2.0" && entry.name.startsWith("@openai/codex"))
    return [
      {
        source: "@openai/codex-sdk/LICENSE (same Apache-2.0 family)",
        text: apache,
      },
    ];
  if (
    entry.name.startsWith("@anthropic-ai/claude-agent-sdk-") &&
    entry.version === "0.3.281"
  )
    return [
      {
        source:
          "@anthropic-ai/claude-agent-sdk@0.3.281/LICENSE.md (same published SDK family)",
        text: anthropicAgentLicense,
      },
    ];
  if (
    (entry.name === "@github/copilot-sdk" ||
      entry.name.startsWith("@github/copilot-sdk-")) &&
    entry.version === "1.0.13"
  )
    return [
      {
        source:
          "github/copilot-sdk v1.0.13 LICENSE (npm package omits the repository license file)",
        text: githubCopilotLicense,
      },
    ];
  if (entry.name.startsWith("@koromix/koffi-") && entry.version === "3.3.1")
    return [
      {
        source: "koffi@3.3.1/LICENSE.txt (same published package family)",
        text: koffiLicense,
      },
    ];
  if (["spdx-exceptions", "spdx-license-ids"].includes(entry.name))
    return [
      {
        source: `${entry.path}/README.md (publisher licensing statement)`,
        text: readFileSync(resolve(directory, "README.md"), "utf8")
          .replace(/\r\n?/g, "\n")
          .trimEnd(),
      },
    ];
  if (entry.name === "@azu/format-text" && entry.version === "1.0.2")
    return [
      {
        source:
          "npm @azu/format-text@1.0.2 metadata and SPDX license-list-data v3.29.0",
        text: `The published package declares BSD-3-Clause and lists azu as author. Its npm tarball and exact upstream gitHead 2f72a7bf808c0818a395c2323d77128352539297 contain no license file or copyright notice. The generic BSD-3-Clause text below is from https://github.com/spdx/license-list-data/blob/v3.29.0/text/BSD-3-Clause.txt (https://spdx.org/licenses/BSD-3-Clause.html). Its <year> and <owner> variables remain unfilled because the publisher supplied neither value; author metadata is not treated as a copyright notice. Upstream source: https://github.com/azu/format-text/tree/2f72a7bf808c0818a395c2323d77128352539297.\n\n${readFileSync(resolve(root, "licenses/BSD-3-Clause-SPDX.txt"), "utf8").replace(/\r\n?/g, "\n").trimEnd()}`,
      },
    ];
  if (entry.name === "standardwebhooks" && entry.version === "1.1.1")
    return [
      {
        source:
          "npm standardwebhooks@1.1.1 metadata and SPDX license-list-data v3.29.0",
        text: `The published package declares MIT. Its npm tarball contains no license file or copyright notice. The generic MIT text below is from https://github.com/spdx/license-list-data/blob/v3.29.0/text/MIT.txt (https://spdx.org/licenses/MIT.html). Its <year> and <copyright holders> variables remain unfilled because the publisher supplied neither value; author metadata is not treated as a copyright notice. Upstream source declared by the package: https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript.\n\n${readFileSync(resolve(root, "licenses/MIT-SPDX.txt"), "utf8").replace(/\r\n?/g, "\n").trimEnd()}`,
      },
    ];
  throw new Error(`Missing license notice for ${entry.path}`);
}

const notices = production.map((entry) => ({
  ...entry,
  notices: noticesFor(entry),
}));
const body =
  `# Third-party notices

Generated from the production dependencies in \`package-lock.json\` and their installed license files for Factory ${lock.version}. Re-run \`npm run notices\` after changing the dependency lock and review the result. Development-only tooling is excluded; optional platform packages are included.

| Package | Version | Declared license | Notice source |
| --- | --- | --- | --- |
${notices.map((entry) => `| \`${entry.name}\` | ${entry.version} | ${entry.license} | ${entry.notices.map((notice) => `\`${notice.source}\``).join(", ")} |`).join("\n")}

## Package notices

${notices.map((entry) => `### ${entry.name}@${entry.version}\n\n${entry.notices.map((notice) => `Source: \`${notice.source}\`\n\n\`\`\`\`text\n${notice.text.replace(/[ \t]+$/gm, "")}\n\`\`\`\``).join("\n\n")}\n`).join("\n")}
`.trimEnd() + "\n";

const target = resolve(root, "THIRD_PARTY_NOTICES.md");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== body)
    throw new Error("THIRD_PARTY_NOTICES.md is stale; run npm run notices");
} else {
  writeFileSync(target, body);
}
