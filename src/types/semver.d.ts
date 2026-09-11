declare module "semver" {
  interface Options {
    loose?: boolean;
  }

  export function validRange(range: string, options?: Options): string | null;
  export function satisfies(version: string, range: string, options?: Options): boolean;
}
