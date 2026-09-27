import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageMetadata: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
);

const version =
  packageMetadata &&
  typeof packageMetadata === "object" &&
  !Array.isArray(packageMetadata)
    ? (packageMetadata as Record<string, unknown>).version
    : undefined;

if (typeof version !== "string" || !version.trim())
  throw new Error("Factory package metadata has no version");

export const FACTORY_VERSION = version;
