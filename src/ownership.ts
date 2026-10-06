/** Ownership is literal Git-relative files or trailing-slash directory prefixes. */
export function validOwnershipPath(path: string): boolean {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return (
    normalized.length > 0 &&
    !/[\\*?]/.test(normalized) &&
    normalized
      .split("/")
      .every(
        (part) =>
          part !== "" && part === part.trim() && part !== "." && part !== "..",
      )
  );
}

export function ownsPath(path: string, scopes: string[]): boolean {
  return scopes.some((scope) =>
    scope.endsWith("/") ? path.startsWith(scope) : path === scope,
  );
}

export function pathsOverlap(left: string, right: string): boolean {
  return ownsPath(left, [right]) || ownsPath(right, [left]);
}
