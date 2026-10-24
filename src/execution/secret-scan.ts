import { isAbsolute } from "node:path";
import type { SecretLintEngineOptionsConfigFileJSON } from "@secretlint/node";

/** Private child entry: no CLI config discovery, globs or target ignore files. */
async function main(): Promise<void> {
  const [source, descriptor, ...extra] = process.argv.slice(2);
  if (!source || !isAbsolute(source) || !descriptor || extra.length)
    throw new Error("Invalid scanner request");
  // Keep dependency-load failures in the same fatal exit path as scan failures.
  const { createEngine } = await import("@secretlint/node");
  const configFileJSON = JSON.parse(
    descriptor,
  ) as SecretLintEngineOptionsConfigFileJSON["configFileJSON"];
  const engine = await createEngine({
    configFileJSON,
    formatter: "compact",
    maskSecrets: true,
    color: false,
    terminalLink: false,
  });
  // The file API retains Secretlint's binary detection and exact-file reading.
  const result = await engine.executeOnFiles({ filePathList: [source] });
  if (result.output) process.stdout.write(`${result.output}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch(() => {
  // Even private child failures need not copy config or source into reports.
  process.stderr.write("Secretlint scan unavailable\n");
  process.exitCode = 2;
});
