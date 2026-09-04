import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import addFormats from "ajv-formats";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = resolve(root, "schemas");
const schemaNames = (await readdir(schemaDirectory))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();
const schemas = await Promise.all(
  schemaNames.map(async (name) =>
    JSON.parse(await readFile(resolve(schemaDirectory, name), "utf8")),
  ),
);

if (schemas.length === 0) throw new Error("no protocol schemas found");

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const ids = new Set();

for (const [index, schema] of schemas.entries()) {
  const name = schemaNames[index];
  if (schema.$schema !== "http://json-schema.org/draft-07/schema#") {
    throw new Error(`${name} must declare JSON Schema draft-07`);
  }
  if (typeof schema.$id !== "string" || !schema.$id.endsWith(`/${name}`)) {
    throw new Error(`${name} must have a stable repository URL as its $id`);
  }
  if (ids.has(schema.$id)) throw new Error(`duplicate schema id: ${schema.$id}`);
  ids.add(schema.$id);
  if (!ajv.validateSchema(schema)) {
    throw new Error(`${name} is not a valid schema: ${ajv.errorsText(ajv.errors)}`);
  }
  ajv.addSchema(schema);
}

for (const schema of schemas) {
  try {
    if (!ajv.getSchema(schema.$id)) throw new Error("schema did not compile");
  } catch (error) {
    throw new Error(`${basename(schema.$id)} failed to compile: ${error.message}`);
  }
}

process.stdout.write(`validated ${schemas.length} JSON Schemas\n`);
