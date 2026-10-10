import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertAgentSessionRef,
  assertAgentSessionScope,
} from "../agent-session.js";
import type { GitHubCopilotSdkConfig } from "../config.js";
import type { AgentSessionRef, HarnessRequest } from "../contracts.js";
import type { WorkerHandleData } from "./worker-process.js";

export const COPILOT_SESSION_ADAPTER = "github-copilot-sdk";
export interface CopilotSessionData {
  selectionDigest: string;
  profileId?: string;
  nativeSessionId: string;
  authenticationDigest?: string;
  nativeSettled?: true;
  workerSettled?: true;
  worker?: WorkerHandleData;
  pendingWorkerIdentity?: string;
}
export interface CopilotWorkerSession {
  root: string;
  owner: string;
  ref: AgentSessionRef;
  nativeSessionId: string;
  resume: boolean;
}
export const copilotDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const copilotSessionOwner = (ref: AgentSessionRef): string =>
  copilotDigest([ref.scope, ref.adapter, ref.identity]);
export function copilotSessionRoot(root: string, identity: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(identity))
    throw new Error("Invalid Copilot session identity");
  return resolve(root, "sessions", identity);
}
export function requireCopilotHome(session: CopilotWorkerSession): string {
  const root = resolve(session.root);
  const home = join(root, "home");
  for (const path of [root, home]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      realpathSync(path) !== path
    )
      throw new Error("Copilot session storage is not private owned storage");
  }
  const marker = join(root, "owner.json");
  const stat = lstatSync(marker);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.() ||
    !isDeepStrictEqual(JSON.parse(readFileSync(marker, "utf8")), {
      owner: session.owner,
      nativeSessionId: session.nativeSessionId,
      selectionDigest: (session.ref.data as CopilotSessionData).selectionDigest,
    })
  )
    throw new Error("Copilot session storage owner does not match");
  return home;
}
export function requireCopilotWorkspace(
  workspace: string | undefined,
  home: string,
): void {
  // SDK workspacePath is the infinite-session state workspace, not repository cwd.
  if (
    !workspace ||
    !realpathSync(workspace).startsWith(`${realpathSync(home)}${sep}`)
  )
    throw new Error("Copilot did not establish private session persistence");
}
export function prepareCopilotSession(
  root: string,
  request: HarnessRequest,
  config: GitHubCopilotSdkConfig,
  authenticationSelection: string,
): CopilotWorkerSession | undefined {
  if (!request.session) return;
  const { scope, identity, retained } = request.session;
  assertAgentSessionScope(scope);
  if (scope.role !== "implementation" || scope.itemId !== request.item.id)
    throw new Error("Copilot session belongs to another Work Item or role");
  const selectionDigest = copilotDigest({
    sdk: "1.0.13",
    config,
    authenticationSelection,
    executionBinding: request.item.executionBinding,
  });
  const directory = copilotSessionRoot(root, identity);
  let nativeSessionId: string = randomUUID();
  if (retained) {
    assertAgentSessionRef(retained, scope);
    const data = retained.data as Partial<CopilotSessionData> | undefined;
    if (
      retained.adapter !== COPILOT_SESSION_ADAPTER ||
      retained.identity !== identity ||
      !isDeepStrictEqual(retained.scope, scope) ||
      retained.status !== "ready" ||
      data?.selectionDigest !== selectionDigest ||
      data.nativeSettled !== true ||
      data.workerSettled !== true ||
      !data.worker ||
      typeof data.nativeSessionId !== "string" ||
      !data.nativeSessionId
    )
      throw new Error(
        "Copilot continuation lacks an exact settled profile binding",
      );
    nativeSessionId = data.nativeSessionId;
  } else if (existsSync(directory))
    throw new Error(
      "Copilot session storage exists without a settled continuation",
    );
  const ref: AgentSessionRef = {
    scope: structuredClone(scope),
    adapter: COPILOT_SESSION_ADAPTER,
    identity,
    turn: (retained?.turn ?? 0) + 1,
    status: "in-flight",
    executionIdentity: request.attemptId,
    data: {
      selectionDigest,
      nativeSessionId,
      ...(request.item.executionBinding && {
        profileId: request.item.executionBinding.id,
      }),
      ...((retained?.data as CopilotSessionData | undefined)
        ?.authenticationDigest && {
        authenticationDigest: (retained!.data as CopilotSessionData)
          .authenticationDigest,
      }),
    },
  };
  const session = {
    root: directory,
    owner: copilotSessionOwner(ref),
    ref,
    nativeSessionId,
    resume: Boolean(retained),
  };
  if (!retained) {
    const base = resolve(root);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    if (realpathSync(base) !== base || !lstatSync(base).isDirectory())
      throw new Error("Copilot adapter root is not an owned directory");
    const parent = resolve(root, "sessions");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory())
      throw new Error("Copilot session parent is not an owned directory");
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, "home"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "owner.json"),
      JSON.stringify({
        owner: session.owner,
        nativeSessionId,
        selectionDigest,
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  requireCopilotHome(session);
  return session;
}
