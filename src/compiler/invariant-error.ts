/** A schema-valid compiler value failed deterministic Factory projection. */
export class CompilerInvariantError extends Error {
  constructor(cause: unknown) {
    super(
      `compiler projection invariant failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.name = "CompilerInvariantError";
  }
}
