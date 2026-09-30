import type { ClaudeManagedClient } from "./claude-managed-client.js";
import {
  claudeTurnDisposition,
  type ClaudeAttemptBoundary,
} from "./claude-managed-events.js";
import {
  claudeByteDigest,
  parseClaudeResultSnapshot,
  type ClaudeResultSnapshot,
} from "./claude-managed-transfer.js";

/** Read only the exact owned session's finished turn. Output publication may lag idle.
 * This supplies result bytes, never a claim of provider cessation or Factory acceptance.
 */
export async function readClaudeManagedOutput(
  client: ClaudeManagedClient,
  sessionId: string,
  boundary: ClaudeAttemptBoundary,
  binding: Omit<ClaudeResultSnapshot, "files">,
): Promise<
  | {
      snapshot: ClaudeResultSnapshot;
      receipt: {
        sessionId: string;
        inputEventId: string;
        endEventId: string;
        fileId: string;
        sha256: string;
        bytes: number;
      };
    }
  | undefined
> {
  const session = await client.retrieve(sessionId);
  if (session.id !== sessionId)
    throw new Error("Claude returned a different session");
  client.assertSession(session, binding.attemptId);
  const turn = claudeTurnDisposition(await client.events(sessionId), boundary);
  if (turn.state === "running") return undefined;
  if (turn.state !== "output-pending")
    throw new Error("Claude turn did not finish normally");
  if (session.status !== "idle") return undefined;
  const files = (await client.files(sessionId)).filter(
    (file) => file.filename === "factory-result.json",
  );
  if (!files.length) return undefined;
  if (files.length !== 1)
    throw new Error("Claude result file identity is ambiguous");
  const file = files[0];
  if (
    !file ||
    file.scope?.type !== "session" ||
    file.scope.id !== sessionId ||
    file.downloadable !== true ||
    !Number.isSafeInteger(file.size_bytes) ||
    file.size_bytes < 0
  )
    throw new Error(
      "Claude output file does not establish the expected session scope",
    );
  const response = await client.download(file.id);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== file.size_bytes)
    throw new Error("Claude result download is truncated");
  const snapshot = parseClaudeResultSnapshot(bytes, binding);
  return {
    snapshot,
    receipt: {
      sessionId,
      inputEventId: boundary.inputEventId,
      endEventId: turn.endEventId,
      fileId: file.id,
      sha256: claudeByteDigest(bytes),
      bytes: bytes.length,
    },
  };
}
