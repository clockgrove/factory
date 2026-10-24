import type { ObjectiveState } from "../state.js";

/** A done merge step's result. */
export interface MergeResult {
  mergeSha: string;
  integratedSha: string;
  at: string;
  /** A native stack's top: every layer's item, merged at `mergeSha`. */
  items?: string[];
}

/**
 * The merge that delivered `id`: its own merge step's, or, for a lower
 * native-stack layer, the stack's merge recorded on the unit's top.
 */
export function mergeOf(
  state: ObjectiveState,
  id: string,
): MergeResult | undefined {
  const own = state.done[`item:${id}:merge`] as MergeResult | undefined;
  if (own) return own;
  for (const [key, value] of Object.entries(state.done))
    if (key.endsWith(":merge") && (value as MergeResult).items?.includes(id))
      return value as MergeResult;
  return undefined;
}
