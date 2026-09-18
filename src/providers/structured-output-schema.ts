const FORBIDDEN_KEYWORDS = [
  "oneOf",
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
] as const;
const TYPED_CONSTRAINTS = [
  "const",
  "enum",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "minItems",
  "maxItems",
] as const;
const MAX_SCHEMA_NESTING = 10;
const MAX_SCHEMA_PROPERTIES = 5_000;
const MAX_SCHEMA_ENUM_VALUES = 1_000;
const MAX_SCHEMA_STRING_BUDGET = 120_000;

function schemaValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function unsupportedRegexConstruct(
  pattern: string,
): "lookaround" | "numeric backreference" | "named backreference" | null {
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (!inCharacterClass && escaped !== undefined && /^[1-9]$/.test(escaped))
        return "numeric backreference";
      if (!inCharacterClass && escaped === "k" && pattern[index + 2] === "<")
        return "named backreference";
      index += 1;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (
      !inCharacterClass &&
      character === "(" &&
      (pattern.startsWith("(?=", index) ||
        pattern.startsWith("(?!", index) ||
        pattern.startsWith("(?<=", index) ||
        pattern.startsWith("(?<!", index))
    )
      return "lookaround";
  }
  return null;
}

/** Validate the bounded JSON Schema subset accepted by Codex structured-output providers. */
export function assertProviderStructuredOutputSchema(schema: unknown): void {
  let properties = 0;
  let enumValues = 0;
  let stringBytes = 0;
  const addString = (value: string) => {
    stringBytes += Buffer.byteLength(value);
    if (stringBytes > MAX_SCHEMA_STRING_BUDGET)
      throw new Error("provider schema string budget exceeds 120000 bytes");
  };
  const visit = (value: unknown, path: string, depth: number): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error(`provider schema node is not an object at ${path}`);
    const node = value as Record<string, unknown>;
    if (
      depth > MAX_SCHEMA_NESTING &&
      (node.type === "object" ||
        node.type === "array" ||
        Object.hasOwn(node, "anyOf") ||
        Object.hasOwn(node, "$defs"))
    )
      throw new Error(`provider schema nesting exceeds 10 at ${path}`);
    for (const keyword of FORBIDDEN_KEYWORDS)
      if (Object.hasOwn(node, keyword))
        throw new Error(`provider schema uses unsupported ${keyword} at ${path}`);
    if (Object.hasOwn(node, "uniqueItems"))
      throw new Error(`provider schema uses unsupported uniqueItems at ${path}/uniqueItems`);
    if (path === "$" && Object.hasOwn(node, "anyOf"))
      throw new Error("provider schema root must not use anyOf");
    if (
      TYPED_CONSTRAINTS.some((keyword) => Object.hasOwn(node, keyword)) &&
      node.type === undefined
    )
      throw new Error(`provider schema constraint lacks type at ${path}`);
    if (Object.hasOwn(node, "pattern")) {
      if (typeof node.pattern !== "string")
        throw new Error(`provider schema pattern is not a string at ${path}/pattern`);
      const unsupported = unsupportedRegexConstruct(node.pattern);
      if (unsupported)
        throw new Error(`provider schema regex uses unsupported ${unsupported} at ${path}/pattern`);
    }
    if (Object.hasOwn(node, "const")) {
      const expected = schemaValueType(node.const);
      const declared = node.type;
      if (
        declared !== expected &&
        !(expected === "integer" && declared === "number") &&
        !(Array.isArray(declared) && declared.includes(expected))
      )
        throw new Error(`provider schema const lacks matching type at ${path}`);
      if (typeof node.const === "string") addString(node.const);
    }
    if (Object.hasOwn(node, "enum")) {
      if (!Array.isArray(node.enum) || node.enum.length === 0)
        throw new Error(`provider schema enum is empty at ${path}`);
      enumValues += node.enum.length;
      if (enumValues > MAX_SCHEMA_ENUM_VALUES)
        throw new Error("provider schema enum value count exceeds 1000");
      const enumTypes = new Set(node.enum.map(schemaValueType));
      const declared = Array.isArray(node.type) ? node.type : [node.type];
      if ([...enumTypes].some((type) => !declared.includes(type)))
        throw new Error(`provider schema enum lacks matching type at ${path}`);
      for (const entry of node.enum) if (typeof entry === "string") addString(entry);
    }
    if (node.type === "object") {
      const childProperties = node.properties;
      if (
        node.additionalProperties !== false ||
        childProperties === null ||
        typeof childProperties !== "object" ||
        Array.isArray(childProperties)
      )
        throw new Error(`provider schema object is not closed at ${path}`);
      const propertyNames = Object.keys(childProperties);
      const required = Array.isArray(node.required) ? node.required : [];
      properties += propertyNames.length;
      if (properties > MAX_SCHEMA_PROPERTIES)
        throw new Error("provider schema property count exceeds 5000");
      if (
        required.length !== propertyNames.length ||
        propertyNames.some((name) => !required.includes(name))
      )
        throw new Error(`provider schema object properties are not all required at ${path}`);
      for (const name of propertyNames) {
        addString(name);
        visit(
          (childProperties as Record<string, unknown>)[name],
          `${path}/properties/${name}`,
          depth + 1,
        );
      }
    }
    if (node.type === "array") {
      if (!Object.hasOwn(node, "items"))
        throw new Error(`provider schema array lacks items at ${path}`);
      visit(node.items, `${path}/items`, depth + 1);
    }
    if (Object.hasOwn(node, "anyOf")) {
      if (!Array.isArray(node.anyOf) || node.anyOf.length === 0)
        throw new Error(`provider schema anyOf is empty at ${path}`);
      node.anyOf.forEach((branch, index) => visit(branch, `${path}/anyOf/${index}`, depth + 1));
    }
    if (Object.hasOwn(node, "$defs")) {
      if (node.$defs === null || typeof node.$defs !== "object" || Array.isArray(node.$defs))
        throw new Error(`provider schema definitions are invalid at ${path}`);
      for (const [name, definition] of Object.entries(node.$defs)) {
        addString(name);
        visit(definition, `${path}/$defs/${name}`, depth + 1);
      }
    }
  };
  visit(schema, "$", 0);
  const root = schema as Record<string, unknown>;
  if (root.type !== "object") throw new Error("provider schema root must be an object");
}
