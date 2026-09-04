import { posix } from "node:path";

export const MAX_REPOSITORY_FILES = 10_000;
export const MAX_MANIFEST_PATHS = 64;

export type RepositoryFile = {
  path: string;
  size?: number;
  binary?: boolean;
  generated?: boolean;
};
export type ExecutionProfile = {
  languages: string[];
  generatedOutput: boolean;
  binaryAssets: boolean;
  deterministicSimulation: boolean;
  visualValidation: boolean;
  validationCommands: string[];
};
export type RepositoryFacts = {
  files: RepositoryFile[];
  scripts?: Record<string, string>;
};
export type ContextManifest = { mustRead: string[]; searchSeeds: string[] };

const cleanPath = (path: string): string => {
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(`invalid repository path: ${path}`);
  }
  return normalized;
};
const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const VALIDATION_SCRIPT_NAMES = ["typecheck", "test", "lint", "check", "verify", "build"];

// Only the documented Node test-runner recipe is specialized here. This is
// deliberately not a shell parser or an arbitrary package-script interpreter.
function nodeTestTargets(command: string): string[] | undefined {
  if (command.length > 1_000 || !/^node --test(?: [A-Za-z0-9_][A-Za-z0-9_./-]*)*$/.test(command))
    return undefined;
  const targets = command.split(" ").slice(2);
  if (
    targets.some(
      (target) =>
        !/\.(?:js|mjs|cjs)$/.test(target) ||
        target.split("/").some((part) => part === "." || part === ".." || part === ""),
    )
  )
    return undefined;
  return targets;
}

export function normalizeRepositoryFacts(input: RepositoryFacts): RepositoryFacts {
  if (input.files.length > MAX_REPOSITORY_FILES)
    throw new Error("repository file inventory exceeds bound");
  const byPath = new Map<string, RepositoryFile>();
  for (const file of input.files) {
    const path = cleanPath(file.path);
    if ((file.size ?? 0) < 0) throw new Error(`invalid size for ${path}`);
    const normalized = {
      path,
      ...(file.size === undefined ? {} : { size: file.size }),
      ...(file.binary === undefined ? {} : { binary: file.binary }),
      ...(file.generated === undefined ? {} : { generated: file.generated }),
    };
    const previous = byPath.get(path);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`conflicting repository facts for ${path}`);
    }
    byPath.set(path, normalized);
  }
  const scripts = Object.fromEntries(
    Object.entries(input.scripts ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    scripts,
  };
}

export function discoverValidationCommands(factsInput: RepositoryFacts): string[] {
  const facts = normalizeRepositoryFacts(factsInput);
  const scripts = facts.scripts ?? {};
  const names = VALIDATION_SCRIPT_NAMES.filter((name) => typeof scripts[name] === "string");
  const observedPaths = new Set(facts.files.map((file) => file.path));
  const recipes = names.flatMap((name) => {
    const recipe = scripts[name]!;
    const targets = nodeTestTargets(recipe);
    return targets && targets.every((target) => observedPaths.has(target)) ? [recipe] : [];
  });
  return [
    ...names.map((name) => (name === "test" ? "npm test" : `npm run ${name}`)),
    ...uniqueSorted(recipes),
  ];
}

export function isGroundedValidationCommand(
  command: string,
  facts: RepositoryFacts,
  scope: string[],
): boolean {
  const observed = discoverValidationCommands(facts);
  if (observed.includes(command)) return true;
  // A bare observed runner permits selecting a concrete existing test, or a
  // test the current Work Item is explicitly allowed to create. An observed
  // targeted recipe does not authorize replacing its targets or adding flags.
  if (!observed.includes("node --test")) return false;
  const targets = nodeTestTargets(command);
  if (!targets?.length) return false;
  const observedPaths = new Set(normalizeRepositoryFacts(facts).files.map((file) => file.path));
  return targets.every(
    (target) =>
      observedPaths.has(target) ||
      scope.some((path) => (path.endsWith("/") ? target.startsWith(path) : target === path)),
  );
}

export function profileRepository(factsInput: RepositoryFacts): ExecutionProfile {
  const facts = normalizeRepositoryFacts(factsInput);
  const paths = facts.files.map((f) => f.path.toLowerCase());
  const languages: string[] = [];
  if (paths.some((p) => /\.(?:ts|tsx|mts|cts)$/.test(p))) languages.push("typescript");
  if (paths.some((p) => /\.(?:js|jsx|mjs|cjs)$/.test(p))) languages.push("javascript");
  const generatedOutput = facts.files.some(
    (f) => f.generated === true || /(^|\/)(?:dist|build|generated)\//i.test(f.path),
  );
  const binaryAssets = facts.files.some(
    (f) => f.binary === true || /\.(?:png|jpe?g|gif|webp|pdf|zip|wasm|mp[34]|mov)$/i.test(f.path),
  );
  const deterministicSimulation = paths.some((p) => /(?:simulation|simulator|replay|seed)/.test(p));
  const visualValidation = paths.some(
    (p) => /(?:screenshot|snapshot|visual|storybook)/.test(p) || /\.(?:png|jpe?g|webp)$/.test(p),
  );
  return {
    languages: uniqueSorted(languages),
    generatedOutput,
    binaryAssets,
    deterministicSimulation,
    visualValidation,
    validationCommands: discoverValidationCommands(facts),
  };
}

export function buildContextManifest(
  factsInput: RepositoryFacts,
  scope: string[],
): ContextManifest {
  const facts = normalizeRepositoryFacts(factsInput);
  const scoped = facts.files
    .map((f) => f.path)
    .filter((path) =>
      scope.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry)),
    );
  const roots = ["AGENTS.md", "package.json", "tsconfig.json"].filter((p) =>
    facts.files.some((f) => f.path === p),
  );
  const mustRead = uniqueSorted([...roots, ...scoped]).slice(0, MAX_MANIFEST_PATHS);
  return {
    mustRead,
    searchSeeds: uniqueSorted(scope).slice(0, MAX_MANIFEST_PATHS),
  };
}
