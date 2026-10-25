/**
 * Media: Work Items that take files as input and produce candidate asset
 * sets a person picks from, delivered through Git LFS. Every function
 * returns its answer as data (`MediaOutcome`), never a throw for a
 * deterministic problem; a failed Git read or a dropped connection throws,
 * and the calling step retries.
 *
 * The flow, as the item steps call it:
 *
 *   work      resolveInputs → (prepareWorkPrompt stages them) → worker →
 *             captureAssets → collect → destinationFinding
 *   select    selectionQuestion / readSelection → materializeSelection
 *   validate  validationMembers → hydrateTree (every LFS file of the fresh
 *             checkout) → commands → rewrittenMedia
 *   review    candidateReceipts (result review, and final review of merged items)
 *   publish   lfsPushIfPointers, called by delivery's publish before it pushes
 *   final     validationMembers → verifyOriginMedia
 *
 * Bytes live as plain files under the Objective's private work directory
 * (`mediaDirectory`), with their sha256 and size in the step's done result;
 * anything committed lives in Git LFS's own content-addressed store.
 *
 * Hold answers: a media hold is the calling step's hold, so the step gets
 * the answer back on its next run and must route each named answer:
 * `retry` runs the step again; `replan` takes the step's replan route (as
 * for an item that can't be done as planned); `repair` returns repair to
 * the work step; `cancel` is the engine's. Each function names the answers
 * its holds can carry. The select step checks `replan` BEFORE readSelection,
 * which knows only set ids and `repair`.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  linkSync,
  lstatSync,
  renameSync,
  rmSync,
  statfsSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  open,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { crashPoint } from "./crash.js";
import { type Held, hold, type Offer, objectiveWide } from "./engine.js";
import {
  blobSizes,
  type CatFile,
  GitRefusal,
  LFS_POINTER_MAX_BYTES,
  lfsFiltered,
  lfsPointer,
  originBound,
  readBlobs,
  secretSearch,
  sha256,
} from "./git.js";
import { namesPath, validPath } from "./objective.js";
import {
  ContainedError,
  copyContained,
  forceRemove,
  openParent,
  readContained,
} from "./paths.js";
import { ancestors, isRecord, MEDIA_ID, ownsPath } from "./planning/graph.js";
import type { Plan, SourceAssetBinding, WorkItem } from "./planning/types.js";
import { localAssetPlace } from "./sandbox.js";
import { errorMessage } from "./text.js";
import {
  FACTORY_EMAIL,
  privateStagingPath,
  scanStaging,
} from "./work/collect.js";
import {
  addWorktree,
  clearStaleLocks,
  hasGitlink,
  hostGit,
  hostGitExit,
  removeWorktree,
} from "./worktree.js";

const MINUTE = 60_000;
const MIB = 1024 * 1024;
/** GitHub accepts attachments up to 100 MB; the bound leaves room above that. */
const MAX_ATTACHMENT_BYTES = 256 * MIB;
/** GitHub's smallest Git LFS file limit (Free and Pro plans). */
const MAX_MEMBER_BYTES = 2 * 1024 * MIB;
/** All members one capture keeps, so a worker can't fill the work directory. */
const MAX_CAPTURE_BYTES = 8 * 1024 * MIB;
const MAX_MANIFEST_BYTES = 1 * MIB;

/** A media answer: a step maps each kind onto its own outcome. */
export type MediaOutcome<T> =
  | { kind: "done"; value: T }
  /**
   * The worker's result is wrong; the finding goes back to the work step.
   * `keepsSelection`: a select repair that isn't about the chosen set's
   * content (a missing .gitattributes LFS rule), so the choice stands.
   * `staging`: capture refused the staged candidate sets themselves.
   */
  | {
      kind: "repair";
      finding: string;
      keepsSelection?: true;
      staging?: "candidates";
    }
  | Held
  /** Transient; `repushed` is set once verifyOriginMedia has re-pushed, for the step to keep. */
  | { kind: "retry"; reason: string; repushed?: true };

/** Where a set came from and on what terms it may be used. */
export interface Provenance {
  source: string;
  rights: string;
  visibility: "private" | "repository";
  lineage: string[];
}

/** One captured member: Factory's private copy, its digest and where it goes. */
export interface CapturedMember {
  role: string;
  destination: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  /** Factory's copy, absolute, under the item's media directory. */
  file: string;
  /** Opaque `{source, values}` an authoritative tool supplied. */
  formatMetadata?: unknown;
}

/** A candidate set as capture checked it; the work step's done result carries these. */
export interface CandidateSet {
  id: string;
  members: CapturedMember[];
  provenance: Provenance;
  relationships?: unknown;
  production?: unknown;
}

/** The select step's done result. */
export interface Selection {
  /** The commit that adds the selected bytes to the work commit; later steps use it. */
  commit: string;
  tree: string;
  set: CandidateSet;
  /** Direct dependents that receive the set as read-only inputs. */
  bound: string[];
  /** Who chose the set and when, and why when the answer said. */
  by: string;
  at: string;
  reason?: string;
}

/** A file a worker gets read-only under `.factory-inputs/assets`. */
export interface MediaInput {
  /** An Objective source asset, a dependency's selected member, or a member of a set the operator sent back. */
  origin: "source" | "selected" | "sent-back";
  role: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  /** Factory's private copy, absolute; never shown to the worker. */
  file: string;
  /** Sources: the binding's kind and path. */
  kind?: NonNullable<SourceAssetBinding["kind"]>;
  path?: string;
  visibility?: "private" | "repository";
  /** Selected members: where they came from and where they sit in the checkout. */
  fromItem?: string;
  set?: string;
  destination?: string;
  provenance?: Provenance;
  formatMetadata?: unknown;
}

/** A selected member a validation or final check expects in a tree. */
export interface SelectedMember {
  item: string;
  set: string;
  role: string;
  destination: string;
  sha256: string;
  bytes: number;
}

/**
 * Git LFS's own filter for one call, instead of `git lfs install --local`
 * writing the shared configuration. These are the exact values worktree.ts
 * allows in repository configuration.
 */
const LFS = [
  "-c",
  "filter.lfs.clean=git-lfs clean -- %f",
  "-c",
  "filter.lfs.smudge=git-lfs smudge -- %f",
  "-c",
  "filter.lfs.process=git-lfs filter-process",
  "-c",
  "filter.lfs.required=true",
];
/** Set and role ids; set ids are also hold answers. */
const ID = MEDIA_ID;
/** Answers a select hold has besides the set ids (the engine adds `fresh`). */
const RESERVED = new Set([
  "repair",
  "retry",
  "replan",
  "cancel",
  "answer",
  "fresh",
]);

/** A deterministic problem with the worker's candidates. */
class Finding extends Error {}

/** The item's private media directory: `<workDir>/assets/<item>`. Pass `deps.workDir(issue)`. */
export function mediaDirectory(workDir: string, itemId: string): string {
  return join(workDir, "assets", itemId);
}

/** The ref that pins an item's selection commit; report and cancel cleanup delete it. */
export function selectionRef(issue: number, itemId: string): string {
  return `refs/factory/${issue}/${itemId}/select`;
}

/** Whether the item produces candidate sets, so it has a select step between work and validate. */
export function needsSelection(item: WorkItem): boolean {
  return Boolean(item.expectedOutputRoles?.length);
}

// ── Inputs ──────────────────────────────────────────────────────────────

export interface InputsRequest {
  /** The operator's checkout: base blobs, the LFS store and origin. */
  checkout: string;
  /** `owner/name`, for the origin check before an LFS fetch. */
  repository: string;
  /** The item's media directory (`mediaDirectory`). */
  directory: string;
  plan: Plan;
  item: WorkItem;
  /** The commit the item's worktree starts from: repository sources are read there. */
  base: string;
  /** The Objective's shown text (objectiveText): a local source must be a path it names (namesPath). */
  body: string;
  /** The operator's media.localAssetRoots: a local source must lie under one. */
  localAssetRoots: readonly string[];
  /** Each dependency's select result, when it has one. */
  selection(itemId: string): Selection | undefined;
  /** The item's own selection kept across a repair that isn't about the media; its members are staged read-only. */
  kept?: Pick<Selection, "set" | "bound">;
  /** The service's GitHub token, for attachments; the worker never sees it. */
  githubToken(): Promise<string>;
  signal: AbortSignal;
}

/**
 * Every file the item's worker reads as input: its source assets (a base
 * blob, LFS bytes from the local store or origin, a private local file or
 * a GitHub attachment), the selected members its dependencies bound to
 * it, and its own kept selection's members on a repair. Each is copied
 * fresh into `<directory>/inputs/` with its digest; pass the list to
 * prepareWorkPrompt as `mediaInputs`, which stages them, and keep it for
 * result and final review (inputReceipts).
 *
 * Step: call before prepareWorkPrompt on every attempt. done → pass on;
 * retry → retry; hold → hold. Its holds carry `retry` (run the work step
 * again), `replan` (the work step's replan route) and `cancel`; a source
 * attachment over its byte bound, or of another repository, holds with
 * `replan` and `cancel` only.
 */
export async function resolveInputs(
  request: InputsRequest,
): Promise<MediaOutcome<MediaInput[]>> {
  const { item, signal } = request;
  const root = join(request.directory, "inputs");
  await forceRemove(root);
  const inputs: MediaInput[] = [];
  for (const [index, binding] of (item.sourceAssets ?? []).entries()) {
    const file = join(root, `source-${index}`);
    const kind = binding.kind ?? "repository";
    const copied =
      kind === "repository"
        ? await repositorySource(request, binding.path, file)
        : kind === "local"
          ? await localSource(
              request.body,
              binding.path,
              request.localAssetRoots,
              file,
            )
          : await attachmentSource(request, binding.path, file);
    if (copied.kind !== "done") return copied;
    inputs.push({
      origin: "source",
      role: binding.role,
      mediaType: binding.mediaType,
      ...copied.value,
      file,
      kind,
      path: binding.path,
      visibility: binding.visibility,
    });
    signal.throwIfAborted();
  }
  const selected = [
    ...item.dependencies.map((id) => [id, request.selection(id)] as const),
    ...(request.kept ? [[item.id, request.kept] as const] : []),
  ];
  for (const [dependency, selection] of selected) {
    if (
      !selection ||
      (dependency !== item.id && !selection.bound.includes(item.id))
    )
      continue;
    const lost = await missingMember(selection.set);
    if (lost)
      return hold(
        `Factory's copy of ${dependency}'s selected ${lost.role} (${lost.file}) is missing or changed, so Work Item ${item.id} can't get it as input. Restore it and answer retry, or answer replan or cancel.`,
        ["retry", "replan", "cancel"],
      );
    for (const member of selection.set.members)
      inputs.push({
        origin: "selected",
        role: member.role,
        mediaType: member.mediaType,
        sha256: member.sha256,
        bytes: member.bytes,
        file: member.file,
        fromItem: dependency,
        set: selection.set.id,
        destination: member.destination,
        provenance: selection.set.provenance,
        ...(member.formatMetadata !== undefined && {
          formatMetadata: member.formatMetadata,
        }),
      });
  }
  return { kind: "done", value: inputs };
}

type Copied = MediaOutcome<{ sha256: string; bytes: number }>;

/** A file tracked at the base; an LFS pointer is resolved to its bytes. */
async function repositorySource(
  request: InputsRequest,
  path: string,
  file: string,
): Promise<Copied> {
  const { checkout, base, signal } = request;
  const blob = await hostGitExit(
    checkout,
    ["cat-file", "blob", `${base}:${path}`],
    {
      signal,
    },
  );
  if (blob.code !== 0)
    return hold(
      `Source asset ${path} is not a file at ${base.slice(0, 12)}, where Work Item ${request.item.id} starts. Answer replan to cite one that is, or cancel.`,
      ["replan", "cancel"],
    );
  const lfs = lfsPointer(blob.stdout);
  if (!lfs) {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await pipeline(
      Readable.from([blob.stdout]),
      createWriteStream(file, { mode: 0o600 }),
    );
    return {
      kind: "done",
      value: { sha256: sha256(blob.stdout), bytes: blob.stdout.length },
    };
  }
  let stored = await lfsObject(checkout, lfs.oid, signal);
  if (!stored) {
    const fetched = await lfsFetch({
      checkout,
      repository: request.repository,
      commit: base,
      paths: [path],
      signal,
    });
    if (fetched) return fetched;
    stored = await lfsObject(checkout, lfs.oid, signal);
  }
  if (!stored)
    return hold(
      `Source asset ${path} is a Git LFS pointer whose object origin did not serve (oid ${lfs.oid}). Push the object to origin's LFS storage and answer retry, or replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  return copyChecked(stored, file, lfs);
}

/**
 * A private file the Objective names, checked again here as a whole path
 * token and against the operator's local asset roots (localAssetPlace),
 * since this copies it to the worker. It is read from its root without
 * following any link below it.
 */
async function localSource(
  body: string,
  path: string,
  roots: readonly string[],
  file: string,
): Promise<Copied> {
  if (!namesPath(body, path))
    return hold(
      `Local source asset ${path} is not a path the Objective names, so Factory won't give it to the worker. Name the exact path in the Objective and answer replan, or cancel.`,
      ["replan", "cancel"],
    );
  const place = localAssetPlace(path, roots);
  if ("refused" in place)
    return hold(
      `Local source asset ${path} can't go to the worker: ${place.refused}. Put the file under a directory media.localAssetRoots names and answer retry; or replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  try {
    return {
      kind: "done",
      value: await copyContained(
        place.root,
        place.relative,
        file,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  } catch (error) {
    if (!(error instanceof ContainedError)) throw error;
    return hold(
      `Local source asset ${path} can't be read: ${error.message}. Put a regular file there, reached without links, and answer retry; or replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  }
}

/** A download that passed MAX_ATTACHMENT_BYTES. */
class TooLarge extends Error {}

/**
 * A GitHub attachment the Objective names, with the service's token sent
 * only on the first request, to the URL itself, and only for a user
 * attachment or one of the configured repository's (another repository's
 * holds); at most 5 redirects, each to https (GitHub chooses where its
 * own redirect goes: storage it may move), never an HTML page, at most
 * MAX_ATTACHMENT_BYTES, and 30 minutes for the whole download.
 */
async function attachmentSource(
  request: InputsRequest,
  path: string,
  file: string,
): Promise<Copied> {
  const refused = (why: string): Copied =>
    hold(
      `GitHub attachment ${path} ${why}. Check the attachment and Factory's GitHub login, then answer retry; or replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  const tooLarge = (bytes?: number): Copied =>
    hold(
      `GitHub attachment ${path} is larger than Factory's bound of ${MAX_ATTACHMENT_BYTES} bytes for an attachment${bytes ? ` (${bytes} bytes)` : ""}. Answer replan to cite a smaller file (or put it in the repository through Git LFS), or cancel.`,
      ["replan", "cancel"],
    );
  // The token goes only to a user attachment or one of the configured
  // repository's own (the plan check recognized the URL's form).
  let owned = false;
  try {
    const url = new URL(path);
    const [first, second, third] = url.pathname.split("/").slice(1);
    owned =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      (first === "user-attachments" ||
        (third === "assets" &&
          `${first}/${second}`.toLowerCase() ===
            request.repository.toLowerCase()));
  } catch {
    owned = false;
  }
  if (!owned)
    return hold(
      `GitHub attachment ${path} is not a user attachment or one of ${request.repository}'s, and Factory sends its GitHub token only to those. Answer replan to cite a copy attached to an issue of ${request.repository} (or put the file in the repository), or cancel.`,
      ["replan", "cancel"],
    );
  const token = await request.githubToken();
  const deadline = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(30 * MINUTE),
  ]);
  let url = path;
  for (let redirect = 0; redirect <= 5; redirect++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: redirect === 0 ? { authorization: `Bearer ${token}` } : {},
        signal: deadline,
      });
    } catch (error) {
      request.signal.throwIfAborted();
      return {
        kind: "retry",
        reason: `Downloading ${path}: ${errorMessage(error)}`,
      };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return refused("redirected without a location");
      const next = new URL(location, url);
      if (next.protocol !== "https:")
        return refused(`redirected to a URL that isn't https (${next.href})`);
      url = next.href;
      continue;
    }
    if (response.status === 429 || response.status >= 500)
      return {
        kind: "retry",
        reason: `Downloading ${path}: HTTP ${response.status}`,
      };
    if (!response.ok || !response.body)
      return refused(`could not be downloaded (HTTP ${response.status})`);
    if ((response.headers.get("content-type") ?? "").startsWith("text/html"))
      return refused("answered with an HTML page instead of the file");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) {
      await response.body.cancel();
      return tooLarge(declared);
    }
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    try {
      let received = 0;
      await pipeline(
        Readable.fromWeb(response.body as WebStream),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > MAX_ATTACHMENT_BYTES) throw new TooLarge();
            yield chunk;
          }
        },
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch (error) {
      await rm(file, { force: true });
      if (error instanceof TooLarge) return tooLarge();
      request.signal.throwIfAborted();
      return {
        kind: "retry",
        reason: `Downloading ${path}: ${errorMessage(error)}`,
      };
    }
    return { kind: "done", value: await digestFile(file) };
  }
  return refused("redirected more than 5 times");
}

/**
 * Copy each input read-only into `<worktree>/.factory-inputs/assets/`,
 * which the caller made fresh, and name each copy by its checkout-relative
 * path. prepareWorkPrompt calls it; collection never commits it.
 */
export async function stageInputs(
  worktree: string,
  inputs: readonly MediaInput[],
): Promise<(Omit<MediaInput, "file"> & { staged: string })[]> {
  if (!inputs.length) return [];
  const root = join(worktree, ".factory-inputs", "assets");
  await mkdir(root, { mode: 0o700 });
  const staged: (Omit<MediaInput, "file"> & { staged: string })[] = [];
  for (const [index, { file, ...input }] of inputs.entries()) {
    const name = `${index}-${safeName(input.destination ?? input.path ?? input.role)}`;
    await copyFile(file, join(root, name));
    await chmod(join(root, name), 0o400);
    staged.push({ ...input, staged: `.factory-inputs/assets/${name}` });
  }
  return staged;
}

/** A file name from the last part of a path or URL, kept to safe characters. */
function safeName(path: string): string {
  return (
    basename(path)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(-80) || "input"
  );
}

// ── Capture ─────────────────────────────────────────────────────────────

/**
 * Check the worker's candidate sets and keep their bytes. Reads
 * `.factory-assets.json` (at most MAX_MANIFEST_BYTES) and secret-scans its
 * exact bytes, since its text reaches the select question; checks ids,
 * roles, owned and unique destinations, provenance, the minimum set count
 * and distinct content; then copies each member from `.factory-media/`,
 * reached without links, to `<directory>/candidates/<set>/<role>-<name>`
 * with its sha256 and size (at most MAX_MEMBER_BYTES each and
 * MAX_CAPTURE_BYTES in all), and secret-scans the copies, since they are
 * committed once selected. It changes nothing in the worktree, so it can
 * run again until its result is kept.
 *
 * Step: call right after the worker finishes and BEFORE collect (collect
 * deletes the manifest). Items without expectedOutputRoles get done [].
 * done → keep `value` for the work result (`sets`) before anything
 * destructive, then remove `.factory-media` and collect; repair → repair
 * to work with the finding; retry → retry (the secret scanner couldn't
 * run); hold → hold. The hold is collect's secret hold, with `repair`
 * (repair to work), `retry` (run the work step's collection again) and
 * `cancel`: route it as the step routes collect's. After collect, call
 * destinationFinding.
 */
export async function captureAssets(input: {
  /** The operator's Secretlint rules (policy.secretlintConfig). */
  secretlintConfig?: string;
  worktree: string;
  item: WorkItem;
  directory: string;
  signal: AbortSignal;
}): Promise<MediaOutcome<CandidateSet[]>> {
  const { worktree, item } = input;
  if (!needsSelection(item)) return { kind: "done", value: [] };
  const candidates = join(input.directory, "candidates");
  await forceRemove(candidates);
  try {
    const manifest = readContained(
      worktree,
      ".factory-assets.json",
      MAX_MANIFEST_BYTES,
    );
    const stopped = await scanStaging(input, [
      { name: ".factory-assets.json", bytes: manifest },
    ]);
    if (stopped) return stopped;
    const sets = readManifest(manifest, item);
    const captured: CandidateSet[] = [];
    let total = 0;
    for (const set of sets) {
      const members: CapturedMember[] = [];
      for (const member of set.members) {
        const file = join(
          candidates,
          set.id.toLowerCase(),
          `${member.role}-${safeName(member.path)}`,
        );
        await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
        const copied = await copyContained(
          worktree,
          member.path,
          file,
          Math.min(MAX_MEMBER_BYTES, MAX_CAPTURE_BYTES - total),
        );
        total += copied.bytes;
        members.push({
          role: member.role,
          destination: member.destination,
          mediaType: member.mediaType,
          ...copied,
          file,
          ...(member.formatMetadata !== undefined && {
            formatMetadata: member.formatMetadata,
          }),
        });
      }
      captured.push({
        id: set.id,
        members,
        provenance: set.provenance,
        ...(set.relationships !== undefined && {
          relationships: set.relationships,
        }),
        ...(set.production !== undefined && { production: set.production }),
      });
    }
    const contents = captured.map((set) =>
      JSON.stringify(
        set.members.map(({ role, sha256 }) => [role, sha256]).sort(),
      ),
    );
    if (new Set(contents).size !== contents.length)
      throw new Finding(
        "Two candidate sets have the same content; each set must differ",
      );
    // The exact bytes kept cross the secret boundary, whatever the declared
    // format; only content Git itself would call binary is left out.
    const texts = [];
    for (const [index, set] of captured.entries())
      for (const [at, member] of set.members.entries())
        if (await textContent(member.file))
          texts.push({
            name: sets[index]!.members[at]!.path,
            path: member.file,
          });
    const secret = await scanStaging(input, texts);
    if (secret) return secret;
    return { kind: "done", value: captured };
  } catch (error) {
    if (error instanceof Finding || error instanceof ContainedError) {
      await forceRemove(candidates);
      return {
        kind: "repair",
        staging: "candidates",
        finding: `Candidate sets refused: ${error.message}. Stage each set as regular files under a real .factory-media/ directory (at most ${MAX_MEMBER_BYTES} bytes a member, ${MAX_CAPTURE_BYTES} in all) and describe it in .factory-assets.json (at most ${MAX_MANIFEST_BYTES} bytes) as the media instructions say.`,
      };
    }
    throw error;
  }
}

interface DeclaredMember {
  role: string;
  path: string;
  mediaType: string;
  destination: string;
  formatMetadata?: unknown;
}

interface DeclaredSet {
  id: string;
  members: DeclaredMember[];
  provenance: Provenance;
  relationships?: unknown;
  production?: unknown;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** `.factory-assets.json`'s bytes, decoded and checked once, here. */
function readManifest(bytes: Buffer, item: WorkItem): DeclaredSet[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Finding(".factory-assets.json is not JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.sets))
    throw new Finding(
      ".factory-assets.json must be an object with a sets array",
    );
  const minimum = item.minimumAssetSets ?? 1;
  if (value.sets.length < minimum)
    throw new Finding(
      `${value.sets.length} set(s) declared; produce at least ${minimum}`,
    );
  const ids = new Set<string>();
  return value.sets.map((raw): DeclaredSet => {
    if (!isRecord(raw) || !text(raw.id) || !ID.test(raw.id))
      throw new Finding(
        "Every set needs an id of letters, digits, - and _ starting with a letter or digit",
      );
    const id = raw.id;
    if (ids.has(id.toLowerCase()) || RESERVED.has(id.toLowerCase()))
      throw new Finding(
        `Set id ${id} is repeated (ids ignore case) or reserved (${[...RESERVED].join(", ")})`,
      );
    ids.add(id.toLowerCase());
    const provenance = raw.provenance;
    if (
      !isRecord(provenance) ||
      !text(provenance.source) ||
      !text(provenance.rights) ||
      (provenance.visibility !== "private" &&
        provenance.visibility !== "repository") ||
      !Array.isArray(provenance.lineage) ||
      !provenance.lineage.every((entry) => typeof entry === "string")
    )
      throw new Finding(
        `Set ${id} needs provenance with source, rights, visibility (private or repository) and lineage`,
      );
    if (!Array.isArray(raw.members) || !raw.members.length)
      throw new Finding(`Set ${id} has no members`);
    const roles = new Set<string>();
    const destinations = new Set<string>();
    const members = raw.members.map((member): DeclaredMember => {
      if (
        !isRecord(member) ||
        !text(member.role) ||
        !text(member.path) ||
        !text(member.mediaType) ||
        !text(member.destination)
      )
        throw new Finding(
          `Set ${id} has a member without role, path, mediaType and destination`,
        );
      if (!ID.test(member.role))
        throw new Finding(
          `Set ${id} member role ${JSON.stringify(member.role)} is not an id: use letters, digits, - and _ starting with a letter or digit (no spaces), the same in every set`,
        );
      const { role, path, destination } = member;
      if (roles.has(role))
        throw new Finding(`Set ${id} lists role ${role} twice`);
      roles.add(role);
      if (!validPath(path) || !path.startsWith(".factory-media/"))
        throw new Finding(
          `Set ${id} member ${role}: path ${path} is not under .factory-media/`,
        );
      if (
        !validPath(destination) ||
        privateStagingPath(destination) ||
        destination === ".git" ||
        destination.startsWith(".git/") ||
        !ownsPath(destination, item.ownedPaths) ||
        destinations.has(destination)
      )
        throw new Finding(
          `Set ${id} member ${role}: destination ${destination} must be a repository path this item owns, used once per set`,
        );
      destinations.add(destination);
      const metadata = member.formatMetadata;
      if (
        metadata !== undefined &&
        (!isRecord(metadata) ||
          !text(metadata.source) ||
          !isRecord(metadata.values))
      )
        throw new Finding(
          `Set ${id} member ${role}: formatMetadata must be {"source": "...", "values": {...}}`,
        );
      return {
        role,
        path,
        mediaType: member.mediaType,
        destination,
        ...(metadata !== undefined && { formatMetadata: metadata }),
      };
    });
    for (const role of item.expectedOutputRoles ?? [])
      if (!roles.has(role))
        throw new Finding(`Set ${id} lacks expected role ${role}`);
    if (
      raw.relationships !== undefined &&
      !(
        Array.isArray(raw.relationships) &&
        raw.relationships.every(
          (edge) =>
            isRecord(edge) &&
            text(edge.from) &&
            text(edge.kind) &&
            typeof edge.toRole === "string" &&
            roles.has(edge.toRole),
        )
      )
    )
      throw new Finding(
        `Set ${id} relationships must each have from, kind and a toRole of the set`,
      );
    if (
      raw.production !== undefined &&
      !(
        isRecord(raw.production) &&
        ["model", "tool"].every(
          (key) =>
            (raw.production as Record<string, unknown>)[key] === undefined ||
            text((raw.production as Record<string, unknown>)[key]),
        )
      )
    )
      throw new Finding(
        `Set ${id} production must be an object whose model and tool, when given, are text`,
      );
    return {
      id,
      members,
      provenance: {
        source: provenance.source,
        rights: provenance.rights,
        visibility: provenance.visibility,
        lineage: provenance.lineage as string[],
      },
      ...(raw.relationships !== undefined && {
        relationships: raw.relationships,
      }),
      ...(raw.production !== undefined && { production: raw.production }),
    };
  });
}

/**
 * Why the collected result is refused for touching a candidate
 * destination, or undefined. Only the selected set is ever written there,
 * by Factory; the worker may neither write nor delete one.
 *
 * Step: call after collect returns `collected`, with the captured sets.
 * A finding → repair to work.
 */
export async function destinationFinding(input: {
  worktree: string;
  base: string;
  commit: string;
  sets: readonly CandidateSet[];
  signal: AbortSignal;
}): Promise<string | undefined> {
  const destinations = [
    ...new Set(
      input.sets.flatMap((set) => set.members.map((m) => m.destination)),
    ),
  ];
  if (!destinations.length) return undefined;
  const changed = (
    await hostGit(
      input.worktree,
      [
        "diff-tree",
        "-r",
        "-z",
        "--name-only",
        "--no-renames",
        input.base,
        input.commit,
        "--",
        ...destinations,
      ],
      { signal: input.signal },
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return changed.length
    ? `The result writes or deletes candidate destinations ${changed.join(", ")}. Factory writes the selected set there; leave final destinations as they are and stage candidates under .factory-media/.`
    : undefined;
}

// ── Selection ───────────────────────────────────────────────────────────

/** Plan items that depend directly on `item`: the only ones a selection can bind. */
export function directDependents(plan: Plan, item: WorkItem): string[] {
  return plan.items
    .filter((other) => other.dependencies.includes(item.id))
    .map((other) => other.id);
}

/**
 * The select hold: the candidate directory, each set and its members, and
 * the answers (each set id in lower case, repair, cancel). Step: return it
 * as a hold while the step has no valid answer.
 */
export function selectionQuestion(
  plan: Plan,
  item: WorkItem,
  sets: readonly CandidateSet[],
  directory: string,
): Held {
  const listed = sets
    .map(
      (set) =>
        `- \`${set.id.toLowerCase()}\`: ${set.members.map((m) => `${m.role} → ${m.destination} (${m.mediaType}, ${m.bytes} bytes)`).join("; ")}. Source: ${set.provenance.source}; rights: ${set.provenance.rights}.`,
    )
    .join("\n");
  const dependents = directDependents(plan, item);
  const bind = dependents.length
    ? ` To give the set to dependents as read-only input, add \`bind ${dependents.join(" ")}\` (any of them) right after the id.`
    : "";
  return hold(
    `Work Item ${item.id} produced ${sets.length} candidate set${sets.length === 1 ? "" : "s"}, in ${join(directory, "candidates")}:\n${listed}\n\nLook at them, then answer with the id of the set to deliver; any text after it is recorded with the selection as your reason.${bind} Answer repair to have the worker make new candidates, or cancel.`,
    [
      ...sets.map(
        (set): Offer => ({
          answer: set.id.toLowerCase(),
          family: "select",
          consequence: `Delivers set ${set.id}; text after the id is recorded as your reason.`,
        }),
      ),
      NEW_CANDIDATES,
      "cancel",
    ],
  );
}

/** `repair` to a media question: the worker makes new candidates. */
const NEW_CANDIDATES: Offer = {
  answer: "repair",
  family: "repair",
  consequence: "The worker makes new candidates.",
};

/** The chosen set's id again: write the set once more. */
function rewrite(again: string): Offer {
  return {
    answer: again,
    family: "retry",
    consequence: "Writes the set again (give the same bind text, if any).",
  };
}

/**
 * The operator's answer to the select hold. Set ids match ignoring case.
 * The answer text may start with `bind ITEM...`: the plan item ids after
 * `bind` name direct dependents. The rest of the text is the operator's
 * reason, recorded with the selection.
 *
 * Step: first, if the answer is `replan`, take the step's replan route:
 * materializeSelection's holds offer it and this function doesn't know it
 * (it would return invalid and ask the selection question again). Then
 * chosen → materializeSelection; repair → repair to work (clearing work
 * and select), from the selection question or a materialize hold alike;
 * invalid → hold selectionQuestion again with `problem` in front; cancel
 * is the engine's.
 */
export function readSelection(
  plan: Plan,
  item: WorkItem,
  sets: readonly CandidateSet[],
  answer: { answer: string; text?: string },
):
  | { kind: "chosen"; set: CandidateSet; bound: string[]; reason?: string }
  | { kind: "repair" }
  | { kind: "invalid"; problem: string } {
  const chosen = answer.answer.toLowerCase();
  if (chosen === "repair") return { kind: "repair" };
  const set = sets.find((candidate) => candidate.id.toLowerCase() === chosen);
  if (!set)
    return {
      kind: "invalid",
      problem: `${answer.answer} is not one of the candidate set ids.`,
    };
  let words = (answer.text ?? "").trim().split(/\s+/).filter(Boolean);
  const ids = new Set(plan.items.map((entry) => entry.id));
  const named: string[] = [];
  if (words[0]?.toLowerCase() === "bind") {
    let count = 1;
    while (count < words.length && ids.has(words[count]!))
      named.push(words[count++]!);
    if (!named.length)
      return {
        kind: "invalid",
        problem: `\`bind\` must be followed by the Work Item ids to give the set to.`,
      };
    words = words.slice(count);
  }
  const dependents = directDependents(plan, item);
  const bound = [...new Set(named)];
  const unknown = bound.filter((id) => !dependents.includes(id));
  if (unknown.length)
    return {
      kind: "invalid",
      problem: `${unknown.join(", ")} ${unknown.length === 1 ? "is not a" : "are not"} direct dependent${unknown.length === 1 ? "" : "s"} of ${item.id}${dependents.length ? ` (${dependents.join(", ")})` : ""}.`,
    };
  const reason = words.join(" ").slice(0, MAX_REASON_CHARS);
  return { kind: "chosen", set, bound, ...(reason ? { reason } : {}) };
}

/** The longest selection reason recorded; the rest of an answer is dropped. */
const MAX_REASON_CHARS = 2000;

/**
 * Write the chosen set at its destinations on top of the work commit, in a
 * fresh worktree, through Git LFS, and commit it as `Factory: selected
 * <set> assets`. Checks first that every captured copy still has its
 * digest, that `.gitattributes` routes every destination through LFS (a
 * repair when the item owns `.gitattributes`, else a hold with `repair`,
 * `replan` and `cancel`), and that no destination exists
 * (except a plain tracked repository source of the same bytes that LFS
 * converts); after, that the staged paths are exactly the destinations and
 * each LFS pointer carries the member's sha256 and size.
 *
 * Step: done → done `{commit, tree, set, bound}` (Selection); later steps
 * use selection.commit in place of work.commit, and a repair must still
 * replay work.commit, not this one. repair → repair to work; hold → hold
 * as the select step's own hold. Its answers come back to the select step
 * and route through readSelection's contract: `replan` (checked before
 * readSelection) → the replan route; `repair` → repair to work (clearing
 * work and select); the chosen set's id (offered where trying again can
 * help) → readSelection chooses it again and this runs again; `cancel` is
 * the engine's.
 */
export async function materializeSelection(input: {
  checkout: string;
  /** A fresh worktree path, such as `<item worktree>.select`; removed after. */
  directory: string;
  item: WorkItem;
  /** The work step's commit. */
  commit: string;
  set: CandidateSet;
  /** The ref that keeps the selection commit from Git's pruning (selectionRef). */
  ref: string;
  signal: AbortSignal;
  log: (event: Record<string, unknown>) => void;
}): Promise<MediaOutcome<{ commit: string; tree: string }>> {
  const { checkout, directory, item, set, signal } = input;
  const again = set.id.toLowerCase();
  const lost = await missingMember(set);
  if (lost)
    return hold(
      `Factory's copy of candidate ${set.id} ${lost.role} (${lost.file}) is missing or changed since capture. Answer repair to have the worker make new candidates, or cancel.`,
      [NEW_CANDIDATES, "cancel"],
    );
  await removeWorktree(checkout, directory, signal);
  await addWorktree(checkout, directory, input.commit, signal, input.log);
  try {
    const git = (args: string[]) => hostGit(directory, args, { signal });
    if (await hasGitlink(directory, { commit: input.commit, signal }))
      return hold(
        `Work Item ${item.id}'s result holds a submodule gitlink; Factory does not write media into such a tree. Answer replan or cancel.`,
        ["replan", "cancel"],
      );
    const destinations = set.members.map((m) => m.destination);
    const filtered = lfsFiltered(
      await git(["check-attr", "-z", "filter", "--", ...destinations]),
    );
    // Selected media travels in Git LFS, whatever its format or size.
    const uncovered = set.members
      .filter((m) => !filtered.has(m.destination))
      .map((m) => `${m.destination} (${m.role})`)
      .join(", ");
    if (uncovered)
      return ownsPath(".gitattributes", item.ownedPaths)
        ? {
            kind: "repair",
            finding: `.gitattributes does not route ${uncovered} through Git LFS, and selected media must be stored in LFS. Add a filter=lfs rule that covers them.`,
            keepsSelection: true,
          }
        : hold(
            `The repository's .gitattributes does not route ${uncovered} through Git LFS, where selected media must be stored, and Work Item ${item.id} doesn't own .gitattributes. Answer repair to have the worker make new candidates at destinations .gitattributes routes through Git LFS, replan to give an item that rule, or cancel.`,
            [NEW_CANDIDATES, "replan", "cancel"],
          );
    for (const member of set.members) {
      const placed = await place(directory, input.commit, item, member, signal);
      if (placed) return placed;
    }
    await hostGit(directory, [...LFS, "add", "--", ...destinations], {
      signal,
    });
    const staged = (
      await git(["diff", "--cached", "--name-only", "-z", "--no-renames"])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (
      staged.length !== destinations.length ||
      staged.some((path) => !destinations.includes(path))
    )
      return hold(
        `Writing set ${set.id} staged ${staged.join(", ") || "nothing"}, not exactly its destinations ${destinations.join(", ")}. Answer ${again} (with the same bind text, if any) to write it again; if it repeats, report it. Or answer repair or cancel.`,
        [rewrite(again), NEW_CANDIDATES, "cancel"],
      );
    await git([
      "-c",
      "user.name=Factory",
      "-c",
      `user.email=${FACTORY_EMAIL}`,
      "commit",
      "--quiet",
      "-m",
      `Factory: selected ${set.id} assets`,
    ]);
    const commit = (await git(["rev-parse", "HEAD"])).toString("utf8").trim();
    for (const member of set.members) {
      const found = lfsPointer(
        await git(["cat-file", "blob", `${commit}:${member.destination}`]),
      );
      if (
        found?.oid !== member.sha256 ||
        found.size !== member.bytes ||
        !(await lfsObject(checkout, member.sha256, signal))
      )
        return hold(
          `Git LFS did not store ${member.destination} as the selected bytes (sha256 ${member.sha256}, ${member.bytes} bytes). Check that git-lfs is installed for the service, then answer ${again} (with the same bind text, if any) to write the set again; or cancel.`,
          [rewrite(again), "cancel"],
        );
    }
    const tree = (await git(["rev-parse", "HEAD^{tree}"]))
      .toString("utf8")
      .trim();
    // The worktree goes below; the ref keeps the commit until cleanup.
    await clearStaleLocks(checkout, { signal, log: input.log });
    await hostGit(checkout, ["update-ref", input.ref, commit], { signal });
    return { kind: "done", value: { commit, tree } };
  } finally {
    await removeWorktree(checkout, directory, signal);
  }
}

/**
 * Keep the sets the operator sent back with a select `repair` apart from
 * `candidates/`, which the next capture replaces (never rewrites in
 * place): hard links (copies across devices) under
 * `<directory>/sent-back/<set>/`. A set whose copies are gone is left out.
 */
export async function keepSentBack(
  directory: string,
  sets: readonly CandidateSet[],
): Promise<CandidateSet[]> {
  const root = sentBackDirectory(directory);
  await forceRemove(root);
  const kept: CandidateSet[] = [];
  for (const set of sets) {
    if (await missingMember(set)) continue;
    const members: CapturedMember[] = [];
    for (const member of set.members) {
      const file = join(root, set.id.toLowerCase(), basename(member.file));
      await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
      await link(member.file, file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EXDEV" && error.code !== "EPERM") throw error;
        return copyFile(member.file, file);
      });
      members.push({ ...member, file });
    }
    kept.push({ ...set, members });
  }
  return kept;
}

/** Where keepSentBack keeps the sets; the work step removes it once the fact is gone. */
export function sentBackDirectory(directory: string): string {
  return join(directory, "sent-back");
}

/**
 * The first captured set whose content is a sent-back set's: the operator
 * already refused it, so offering it again asks the same question.
 */
export function resentSet(
  captured: readonly CandidateSet[],
  sentBack: readonly CandidateSet[],
): { set: string; sentBack: string } | undefined {
  const content = (set: CandidateSet) =>
    JSON.stringify(
      set.members.map(({ role, sha256 }) => [role, sha256]).sort(),
    );
  const refused = new Map(sentBack.map((set) => [content(set), set.id]));
  for (const set of captured) {
    const match = refused.get(content(set));
    if (match !== undefined) return { set: set.id, sentBack: match };
  }
  return undefined;
}

/** The sent-back sets' members as read-only worker inputs; a set whose copies are gone is left out. */
export async function sentBackInputs(
  itemId: string,
  sets: readonly CandidateSet[],
): Promise<MediaInput[]> {
  const inputs: MediaInput[] = [];
  for (const set of sets) {
    if (await missingMember(set)) continue;
    for (const member of set.members)
      inputs.push({
        origin: "sent-back",
        role: member.role,
        mediaType: member.mediaType,
        sha256: member.sha256,
        bytes: member.bytes,
        file: member.file,
        fromItem: itemId,
        set: set.id,
        destination: member.destination,
        provenance: set.provenance,
      });
  }
  return inputs;
}

/** The first member whose private copy is missing or no longer has its captured digest. */
export async function missingMember(
  set: CandidateSet,
): Promise<CapturedMember | undefined> {
  for (const member of set.members) {
    const held = await digestFile(member.file).catch(() => undefined);
    if (held?.sha256 !== member.sha256 || held.bytes !== member.bytes)
      return member;
  }
  return undefined;
}

/**
 * Write one member at its destination without following a link. An
 * existing destination may only be a plain tracked repository source with
 * the same bytes, which LFS now stores as a pointer. Its holds offer
 * `replan` and `cancel` and are materializeSelection's (see its routing).
 */
async function place(
  directory: string,
  commit: string,
  item: WorkItem,
  member: CapturedMember,
  signal: AbortSignal,
): Promise<MediaOutcome<never> | undefined> {
  let parent: ReturnType<typeof openParent>;
  try {
    parent = openParent(directory, member.destination, true);
  } catch (error) {
    return hold(
      `Destination ${member.destination} can't be written: ${errorMessage(error)}. Answer replan to choose another destination, or cancel.`,
      ["replan", "cancel"],
    );
  }
  const target = join(parent.anchor, parent.name);
  try {
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
      const entry = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(
        (
          await hostGit(
            directory,
            ["ls-tree", commit, "--", member.destination],
            { signal },
          )
        ).toString("utf8"),
      );
      const blob = entry
        ? await hostGit(directory, ["cat-file", "blob", entry[2]!], { signal })
        : undefined;
      const sameSource =
        existing.isFile() &&
        blob !== undefined &&
        !lfsPointer(blob) &&
        sha256(blob) === member.sha256 &&
        (item.sourceAssets ?? []).some(
          (source) =>
            (source.kind ?? "repository") === "repository" &&
            source.path === member.destination,
        );
      if (!sameSource)
        return hold(
          `Destination ${member.destination} already exists in Work Item ${item.id}'s result; Factory writes selected media only to new paths (or converts a same-bytes repository source to LFS). Answer replan to choose another destination, or cancel.`,
          ["replan", "cancel"],
        );
      await unlink(target);
      await copyFile(member.file, target);
      if (entry![1] === "100755") await chmod(target, 0o755);
      return undefined;
    }
    await copyFile(member.file, target);
    return undefined;
  } finally {
    closeSync(parent.fd);
  }
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * The selected members a tree is expected to hold: those of the item and
 * its dependency closure (every item when `item` is undefined, for final
 * validation). Each must be in the tree as its Git LFS pointer.
 */
export function validationMembers(
  plan: Plan,
  item: WorkItem | undefined,
  selection: (itemId: string) => Selection | undefined,
): SelectedMember[] {
  const closure = new Set(
    item
      ? [item.id, ...ancestors(plan.items, item.id)]
      : plan.items.map((entry) => entry.id),
  );
  const members: SelectedMember[] = [];
  for (const id of closure) {
    const chosen = selection(id);
    if (!chosen) continue;
    for (const member of chosen.set.members)
      members.push({
        item: id,
        set: chosen.set.id,
        role: member.role,
        destination: member.destination,
        sha256: member.sha256,
        bytes: member.bytes,
      });
  }
  return members;
}

/**
 * A Git LFS file a validation checkout holds as its pointer: `path`, and
 * the object's sha256 and size the pointer names.
 */
export interface LfsFile {
  path: string;
  sha256: string;
  bytes: number;
  /**
   * A hard link to the local store's object, with its inode: the sandbox
   * mounts it read-only (runSandboxed's readOnlyFiles), so no command can
   * change it or the store, and rewrittenMedia needn't read it. After
   * each command the path must still hold that inode (validate.ts
   * movedLinks): a command that moved its directory could leave other bytes
   * at the path, and the store's object writable to the next command.
   */
  linked?: { ino: number };
}

/**
 * Restored files linked to the local store at most: each is one read-only
 * mount in the command sandbox. The largest files are linked first; the
 * rest are cloned or copied.
 */
const MAX_LINKED_FILES = 1000;
/** Free space a copy of an LFS file for validation must leave on its disk. */
const RESERVED_BYTES = 1024 * MIB;

/**
 * Restore the bytes of EVERY Git LFS file in a validation checkout: each
 * regular file at a `filter=lfs` path whose HEAD blob is an LFS pointer,
 * as `git lfs pull` would, so the commands see the repository as a person
 * who clones it does, whatever the format. Objects come from the local LFS
 * store; those it lacks are fetched from origin at `commit` first. Each
 * file is checked against its pointer's size, and a copy against its
 * sha256 too. Every selected member must be its exact Git LFS pointer in
 * the tree, else it holds. Returns the restored files: they now differ
 * from their pointer blobs, so the caller leaves them out of its
 * clean-checkout and mutation checks, mounts the linked ones read-only for
 * its commands, and gives them to rewrittenMedia after the commands.
 *
 * Cost follows the disk, not the repository's LFS size: with `link` (the
 * commands run in the sandbox, which mounts linked files read-only), the
 * largest MAX_LINKED_FILES files are hard links to the store's objects
 * where the store shares their filesystem; the rest are reflinked clones
 * where the filesystem supports them, else copies. A copy that would leave
 * less than RESERVED_BYTES free holds, naming the space it needs.
 *
 * Each file is written literally: Factory replaces the pointer file itself,
 * reached without following a link. `git lfs checkout`
 * can't do that: its arguments are gitignore-style patterns, so a glob
 * character or a bare file name restores other files too, and it matches
 * nothing for a `:(literal)` pathspec (checked with git-lfs 3.7.1).
 *
 * Validation: call in the fresh checkout after it is made and before any
 * command runs, with validationMembers(plan, item, …). done → run the
 * commands; retry (origin unreachable) → retry; hold → hold as the
 * validate step's own. Its holds offer `retry` (validate again), `replan`
 * (a selected member's pointer is gone: the step's replan route) and
 * `cancel`.
 */
export async function hydrateTree(input: {
  directory: string;
  repository: string;
  commit: string;
  members: readonly SelectedMember[];
  /** Link files to the store: only when every command runs in the sandbox. */
  link: boolean;
  signal: AbortSignal;
}): Promise<Exclude<MediaOutcome<LfsFile[]>, { kind: "repair" }>> {
  const { directory, signal } = input;
  for (const member of input.members) {
    const blob = await hostGitExit(
      directory,
      ["cat-file", "blob", `HEAD:${member.destination}`],
      { signal },
    );
    const found = blob.code === 0 ? lfsPointer(blob.stdout) : undefined;
    if (found?.oid !== member.sha256 || found.size !== member.bytes)
      return hold(
        `${member.destination}, ${member.item}'s selected ${member.role}, is not the Git LFS pointer of the selected bytes in this tree; someone may have changed it. Restore it on the default branch and answer retry, or replan or cancel.`,
        ["retry", "replan", "cancel"],
      );
  }
  const files = await lfsFiles(directory, signal);
  const missing = await fetchMissing(
    { ...input, checkout: directory },
    files.map((file) => ({ ...file, oid: file.sha256 })),
  );
  if (!Array.isArray(missing)) return missing;
  if (missing.length)
    return hold(
      `Origin does not serve the Git LFS objects of ${missing
        .slice(0, 20)
        .map((file) => `${file.path} (oid ${file.sha256}, ${file.bytes} bytes)`)
        .join(
          ", ",
        )}${missing.length > 20 ? ` and ${missing.length - 20} more` : ""} at ${input.commit.slice(0, 12)}, and Factory's checkout doesn't hold them, so validation can't restore those files. Push the objects to origin's LFS storage (\`git lfs push --object-id origin <oid>\` from a clone that has them) and answer retry, or cancel.`,
    );
  const restored: LfsFile[] = [];
  let links = 0;
  for (const file of [...files].sort((a, b) => b.bytes - a.bytes)) {
    const link =
      input.link && file.mode === "100644" && links < MAX_LINKED_FILES;
    const held = await restoreObject(directory, file, link, signal);
    if (typeof held === "object" && "free" in held)
      return hold(
        `Restoring the Git LFS file ${file.path} (${file.bytes} bytes) for validation would leave less than ${RESERVED_BYTES} bytes free on the disk of ${directory} (${held.free} bytes free). Free disk space, then answer retry; or cancel. Factory links LFS files instead of copying them when Factory's state directory and the target checkout share a filesystem.`,
      );
    if (typeof held !== "number" && held !== "cloned" && held !== "copied")
      return hold(
        `Factory could not restore ${file.path} (sha256 ${file.sha256}, ${file.bytes} bytes) from the local Git LFS store: the store's object or the checkout's file is not a regular file with those bytes. Remove the object from the target checkout's .git/lfs/objects and answer retry, or cancel.`,
      );
    if (typeof held === "number") links += 1;
    restored.push({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      ...(typeof held === "number" ? { linked: { ino: held } } : {}),
    });
  }
  return { kind: "done", value: restored };
}

/** The checkout's Git LFS files at HEAD: pointers at `filter=lfs` paths. */
async function lfsFiles(
  directory: string,
  signal: AbortSignal,
): Promise<(LfsFile & { mode: string })[]> {
  const entries = (
    await hostGit(directory, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
      signal,
    })
  )
    .toString("utf8")
    .split("\0");
  // "<mode> <type> <oid>\t<path>"; only regular files can be pointers Git LFS smudges.
  const blobs: { oid: string; path: string }[] = [];
  const modes = new Map<string, string>();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (tab > 0 && type === "blob" && mode?.startsWith("100") && oid) {
      blobs.push({ oid, path: entry.slice(tab + 1) });
      modes.set(entry.slice(tab + 1), mode);
    }
  }
  const pointers = await pointerBlobs(directory, blobs, signal);
  if (!pointers.length) return [];
  const filtered = lfsFiltered(
    await hostGit(directory, ["check-attr", "-z", "--stdin", "filter"], {
      input: `${pointers.map((p) => p.path).join("\0")}\0`,
      signal,
    }),
  );
  return pointers
    .filter((pointer) => filtered.has(pointer.path))
    .map(({ path, oid, size }) => ({
      path,
      sha256: oid,
      bytes: size,
      mode: modes.get(path)!,
    }));
}

/**
 * The restored files whose bytes are no longer their pointers' (or that
 * are no longer regular files reached without links): what a validation
 * command rewrote. Call after the commands, with hydrateTree's result;
 * linked files were read-only to the commands and aren't read again.
 */
export async function rewrittenMedia(
  directory: string,
  restored: readonly LfsFile[],
): Promise<string[]> {
  const changed: string[] = [];
  for (const file of restored) {
    // Mounted read-only: no command could change it.
    if (file.linked) continue;
    let parent: ReturnType<typeof openParent>;
    try {
      parent = openParent(directory, file.path, false);
    } catch {
      // Gone, or now behind a link.
      changed.push(file.path);
      continue;
    }
    let held: { sha256: string; bytes: number } | undefined;
    try {
      const target = `${parent.anchor}/${parent.name}`;
      if (lstatSync(target, { throwIfNoEntry: false })?.isFile())
        held = await digestFile(target);
    } finally {
      closeSync(parent.fd);
    }
    if (held?.sha256 !== file.sha256 || held.bytes !== file.bytes)
      changed.push(file.path);
  }
  return changed;
}

/**
 * Replace `file`'s pointer file in `directory`, reached without links, with
 * the local store's object: a hard link (`link`), else a reflinked clone,
 * else a copy checked against the pointer's sha256, which must leave
 * RESERVED_BYTES free. A link or clone replaces the pointer by a rename and
 * keeps its mode; a copy writes over it. A link returns its inode.
 * Undefined when the store lacks the object or either file isn't a regular
 * file of the pointer's size.
 */
async function restoreObject(
  directory: string,
  file: LfsFile,
  link: boolean,
  signal: AbortSignal,
): Promise<number | "cloned" | "copied" | { free: number } | undefined> {
  const stored = await lfsObject(directory, file.sha256, signal);
  if (!stored) return undefined;
  const source = join(stored.root, stored.relative);
  if (lstatSync(source, { throwIfNoEntry: false })?.size !== file.bytes)
    return undefined;
  let parent: ReturnType<typeof openParent>;
  try {
    parent = openParent(directory, file.path, false);
  } catch {
    return undefined;
  }
  try {
    const target = `${parent.anchor}/${parent.name}`;
    const pointer = lstatSync(target, { throwIfNoEntry: false });
    if (!pointer?.isFile()) return undefined;
    // Linked or cloned beside the pointer, then renamed over it.
    const staged = `${parent.anchor}/.${parent.name}.factory-lfs`;
    rmSync(staged, { force: true });
    if (link)
      try {
        linkSync(source, staged);
        renameSync(staged, target);
        return lstatSync(target).ino;
      } catch {
        // Another filesystem, or the link limit: clone or copy instead.
        rmSync(staged, { force: true });
      }
    try {
      copyFileSync(source, staged, constants.COPYFILE_FICLONE_FORCE);
      await chmod(staged, pointer.mode & 0o777);
      renameSync(staged, target);
      return "cloned";
    } catch {
      // No reflinks on this filesystem: copy.
      rmSync(staged, { force: true });
    }
    const { bavail, bsize } = statfsSync(directory);
    const free = Number(bavail) * Number(bsize);
    if (free - file.bytes < RESERVED_BYTES) return { free };
    const held = await copyContained(
      stored.root,
      stored.relative,
      target,
      file.bytes,
      true,
    );
    return held.sha256 === file.sha256 && held.bytes === file.bytes
      ? "copied"
      : undefined;
  } catch (error) {
    if (error instanceof ContainedError) return undefined;
    throw error;
  } finally {
    closeSync(parent.fd);
  }
}

// ── Publish ─────────────────────────────────────────────────────────────

/** The LFS pointers (oid, size, path) that `commit` adds or changes relative to `base`. */
async function addedPointers(
  checkout: string,
  base: string,
  commit: string,
  signal: AbortSignal,
): Promise<{ oid: string; size: number; path: string }[]> {
  const entries = (
    await hostGit(
      checkout,
      [
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--diff-filter=d",
        base,
        commit,
      ],
      { signal },
    )
  )
    .toString("utf8")
    .split("\0");
  // Raw entries: ":<old mode> <new mode> <old oid> <new oid> <status>", then the path.
  const blobs: { oid: string; path: string }[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const [, mode, , oid] = entries[index]!.split(" ");
    if (mode?.startsWith("100") && oid)
      blobs.push({ oid, path: entries[index + 1]! });
  }
  return pointerBlobs(checkout, blobs, signal);
}

/** The blobs among `blobs` that are Git LFS pointers, with the oid and size each names. */
async function pointerBlobs(
  checkout: string,
  blobs: readonly { oid: string; path: string }[],
  signal: AbortSignal,
): Promise<{ oid: string; size: number; path: string }[]> {
  const catFile: CatFile = (args, input) =>
    hostGit(checkout, args, { input, signal });
  const sizes = await blobSizes(
    catFile,
    blobs.map((b) => b.oid),
  );
  const small = blobs.filter(
    (b) =>
      (sizes.get(b.oid) ?? Number.POSITIVE_INFINITY) <= LFS_POINTER_MAX_BYTES,
  );
  const bodies = await readBlobs(
    catFile,
    small.map((b) => b.oid),
  );
  const pointers: { oid: string; size: number; path: string }[] = [];
  small.forEach((blob, index) => {
    const found = lfsPointer(bodies[index]!);
    if (found) pointers.push({ ...found, path: blob.path });
  });
  return pointers;
}

/**
 * Upload the LFS objects behind any pointer `commit` adds relative to
 * `base`, before its branch is pushed: Factory runs no hooks, so LFS's
 * pre-push hook never does it. The objects are pushed by id, since
 * `git lfs push origin <commit>` skips what origin's remote-tracking refs
 * already reach (a republish after the branch was pushed). Content-
 * addressed and idempotent, so it repeats safely on every publish attempt.
 * A pointer whose object neither Factory nor origin has is the result's
 * fault.
 *
 * Delivery: `publish` (delivery.ts) calls it just before it pushes the
 * branch, with the item's base commit as `base`; steps don't call it. It
 * makes its own origin check. done → push; repair, retry and hold come back
 * as publish's own (repair → the item's delivery repair with the finding;
 * a hold's answers are `retry`, publish again, and `cancel`).
 */
export async function lfsPushIfPointers(input: {
  checkout: string;
  repository: string;
  base: string;
  commit: string;
  signal: AbortSignal;
}): Promise<MediaOutcome<{ pushed: boolean }>> {
  const pointers = await addedPointers(
    input.checkout,
    input.base,
    input.commit,
    input.signal,
  );
  if (!pointers.length) return { kind: "done", value: { pushed: false } };
  // Worktrees skip LFS smudge, so a moved or restored LFS file is a pointer
  // whose object only origin has: fetch those, and refuse only what origin
  // doesn't serve either.
  const missing = await fetchMissing(input, pointers);
  if (!Array.isArray(missing)) return missing;
  if (missing.length)
    return {
      kind: "repair",
      finding: `The result adds Git LFS pointers whose objects don't exist: ${missing.map((found) => found.path).join(", ")}. Commit real files (Factory stores them in LFS) or leave those paths unchanged.`,
    };
  const pushed = await lfsPush({
    ...input,
    oids: [...new Set(pointers.map((found) => found.oid))],
  });
  return pushed ?? { kind: "done", value: { pushed: true } };
}

/**
 * The paths of the LFS pointers `commit` adds against `base` whose object
 * in the local store holds a value of `secrets` (git.ts secretSearch).
 * An object only origin has isn't uploaded, so it isn't read. Publish
 * calls this before it pushes, with pathsHoldingSecrets for the blobs.
 */
export async function lfsObjectsHoldingSecrets(
  checkout: string,
  base: string,
  commit: string,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  if (!secrets.length) return [];
  const search = secretSearch(secrets);
  const holding: string[] = [];
  for (const pointer of await addedPointers(checkout, base, commit, signal)) {
    const stored = await lfsObject(checkout, pointer.oid, signal);
    if (!stored) continue;
    const object = search();
    for await (const chunk of createReadStream(
      join(stored.root, stored.relative),
      { signal },
    )) {
      object.feed(chunk as Buffer);
      if (object.found) break;
    }
    if (object.found) holding.push(pointer.path);
  }
  return holding;
}

/**
 * The files whose LFS objects the local store lacks, after one fetch of
 * them from origin at `commit`; or the fetch's hold or retry.
 */
async function fetchMissing<File extends { path: string; oid: string }>(
  input: {
    checkout: string;
    repository: string;
    commit: string;
    signal: AbortSignal;
  },
  files: readonly File[],
): Promise<File[] | Exclude<MediaOutcome<never>, { kind: "repair" }>> {
  const absent = async () => {
    const missing: File[] = [];
    for (const file of files)
      if (!(await lfsObject(input.checkout, file.oid, input.signal)))
        missing.push(file);
    return missing;
  };
  const missing = await absent();
  if (!missing.length) return missing;
  const fetched = await lfsFetch({
    ...input,
    paths: missing.map((file) => file.path),
  });
  return fetched ?? absent();
}

/**
 * `git lfs fetch origin <commit>` of the LFS objects behind `paths` into
 * the local store (or `storage`), with the operator's credentials, after
 * the origin check. A fetch that fails while origin answers leaves the
 * objects missing for the caller to judge; an unreachable origin is the
 * network's, a retry.
 */
async function lfsFetch(input: {
  checkout: string;
  repository: string;
  commit: string;
  paths: readonly string[];
  storage?: string;
  signal: AbortSignal;
}): Promise<Exclude<MediaOutcome<never>, { kind: "repair" }> | undefined> {
  const toOrigin = await originRunner(input);
  if (typeof toOrigin !== "function") return toOrigin;
  const plain = input.paths.every((path) => !/[,*?[\]\\!]/.test(path));
  let fetched: string | undefined;
  try {
    await toOrigin(
      [
        ...(input.storage ? ["-c", `lfs.storage=${input.storage}`] : []),
        ...LFS,
        "lfs",
        "fetch",
        "origin",
        input.commit,
        ...(plain ? ["--include", input.paths.join(",")] : []),
      ],
      30 * MINUTE,
    );
  } catch (error) {
    fetched = errorMessage(error);
  }
  if (fetched !== undefined && !(await reachable(toOrigin, input.signal)))
    return {
      kind: "retry",
      reason: `Fetching LFS objects from origin: ${fetched}`,
    };
  return undefined;
}

/**
 * `git lfs push --object-id origin <oid...>` from the local store, with
 * the operator's credentials, after the origin check.
 */
async function lfsPush(input: {
  checkout: string;
  repository: string;
  oids: readonly string[];
  signal: AbortSignal;
}): Promise<MediaOutcome<never> | undefined> {
  const toOrigin = await originRunner(input);
  if (typeof toOrigin !== "function") return toOrigin;
  try {
    await toOrigin(
      [...LFS, "lfs", "push", "--object-id", "origin", ...input.oids],
      30 * MINUTE,
    );
  } catch (error) {
    input.signal.throwIfAborted();
    return {
      kind: "retry",
      reason: `git lfs push of ${input.oids.length} object(s): ${errorMessage(error)}`,
    };
  }
  return undefined;
}

// ── Final ───────────────────────────────────────────────────────────────

/**
 * Prove origin serves every selected member at the integrated commit:
 * each destination holds its member's pointer, and a
 * `git lfs fetch` into an empty store downloads objects with the selected
 * sha256 and size. Missing objects are re-pushed by object id from the
 * local store once (retry with `repushed`), then hold. Returns a text
 * summary for final review.
 *
 * Step: in final, after validateTree passes, with validationMembers(plan,
 * undefined, …) and `repushed` from state.kept. done → keep the summary
 * in the final result; retry → retry, keeping `repushed: true` when set;
 * hold → hold, whose answers are `retry` (verify again) and `cancel`.
 */
export async function verifyOriginMedia(input: {
  checkout: string;
  repository: string;
  commit: string;
  members: readonly SelectedMember[];
  /** A private scratch directory for the empty LFS store; replaced, then removed. */
  scratch: string;
  repushed: boolean;
  signal: AbortSignal;
}): Promise<MediaOutcome<{ summary: string }>> {
  const { checkout, commit, signal } = input;
  if (!input.members.length) return { kind: "done", value: { summary: "" } };
  for (const member of input.members) {
    const blob = await hostGitExit(
      checkout,
      ["cat-file", "blob", `${commit}:${member.destination}`],
      { signal },
    );
    const found = blob.code === 0 ? lfsPointer(blob.stdout) : undefined;
    if (found?.oid !== member.sha256 || found.size !== member.bytes)
      return hold(
        `${member.destination} at ${commit.slice(0, 12)} is not the Git LFS pointer of ${member.item}'s selected ${member.role} (sha256 ${member.sha256}); someone may have changed it after the merge. Restore it on the default branch and answer retry, or cancel.`,
      );
  }
  const missing: SelectedMember[] = [];
  await forceRemove(input.scratch);
  await mkdir(input.scratch, { recursive: true, mode: 0o700 });
  try {
    const fetched = await lfsFetch({
      checkout,
      repository: input.repository,
      commit,
      paths: input.members.map((m) => m.destination),
      storage: input.scratch,
      signal,
    });
    if (fetched) return fetched;
    for (const member of input.members) {
      const object = join(
        input.scratch,
        "objects",
        member.sha256.slice(0, 2),
        member.sha256.slice(2, 4),
        member.sha256,
      );
      const held = await digestFile(object).catch(() => undefined);
      if (held?.sha256 !== member.sha256 || held.bytes !== member.bytes)
        missing.push(member);
    }
  } finally {
    await forceRemove(input.scratch);
  }
  if (missing.length) {
    const paths = missing.map((m) => m.destination).join(", ");
    if (input.repushed)
      return hold(
        `Origin still does not serve the selected Git LFS objects for ${paths} after Factory pushed them again. Check the repository's LFS storage and quota, then answer retry; or cancel.`,
      );
    const unheld: string[] = [];
    for (const member of missing)
      if (!(await lfsObject(checkout, member.sha256, signal)))
        unheld.push(member.destination);
    if (unheld.length)
      return hold(
        `Origin does not serve the selected Git LFS objects for ${unheld.join(", ")}, and Factory's checkout no longer holds them to push again. Push them to origin's LFS storage, then answer retry; or cancel.`,
      );
    // By object id: a rerun after a crash verifies again and pushes once
    // more at most.
    crashPoint("final:lfs-repush:before");
    const pushed = await lfsPush({
      checkout,
      repository: input.repository,
      oids: [...new Set(missing.map((m) => m.sha256))],
      signal,
    });
    crashPoint("final:lfs-repush:after");
    if (pushed) return pushed;
    return {
      kind: "retry",
      reason: `Origin did not serve LFS objects for ${paths}; Factory pushed them again.`,
      repushed: true,
    };
  }
  return {
    kind: "done",
    value: {
      summary: `Selected media verified on origin at ${commit.slice(0, 12)}:\n${input.members.map((m) => `- ${m.item} set ${m.set} ${m.role} → ${m.destination}: sha256 ${m.sha256}, ${m.bytes} bytes (Git LFS)`).join("\n")}`,
    },
  };
}

/**
 * The origin check (git.ts originBound) before a remote call's `try`, so
 * no catch turns its refusal into a retry: a runner, or the hold.
 */
async function originRunner(input: {
  checkout: string;
  repository: string;
  signal: AbortSignal;
}): Promise<
  | Awaited<ReturnType<typeof originBound>>
  | Extract<MediaOutcome<never>, { kind: "hold" }>
> {
  try {
    return await originBound(input.checkout, input.repository, input.signal);
  } catch (error) {
    if (error instanceof GitRefusal) return objectiveWide(hold(error.message));
    throw error;
  }
}

/** Whether origin answers at all, through a runner already bound. */
async function reachable(
  toOrigin: Awaited<ReturnType<typeof originBound>>,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await toOrigin(["ls-remote", "origin", "HEAD"], MINUTE);
    return true;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

/** One item's captured candidate sets and the operator's selection, for review. */
export interface CandidateRecord {
  item: WorkItem;
  sets: readonly CandidateSet[];
  selection: Selection;
}

/** Bounds for the candidate copies one review's evidence root holds. */
const REVIEW_MEMBER_BYTES = 1 * MIB;
const REVIEW_CANDIDATE_BYTES = 64 * MIB;

/** What captureAssets and destinationFinding check; a set that fails one is never captured. */
const CAPTURE_CHECKS = [
  "The manifest .factory-assets.json is within its byte bound, passed the secret scan and is well-formed JSON with a sets array",
  "The manifest declares at least the item's minimum number of sets",
  "Each set id is well-formed, unique ignoring case and not a reserved answer",
  "Each set has provenance with source, rights, visibility (private or repository) and lineage",
  "Each set has members; each member has a well-formed role used once in its set, a staged path under .factory-media/, a media type and a destination that is a repository path the item owns, used once in its set",
  "Each set has every expected output role",
  "Each member is a regular file reached without links, within the per-member and per-capture byte bounds; Factory copied it to private staging and recorded the copy's sha256 and byte count",
  "No two sets have the same content (the same sha256 for every role)",
  "Every text member passed the secret scan",
  "The worker's committed result neither writes nor deletes any candidate destination",
];

/** What materializeSelection checks for the selected set before it commits it. */
const SELECTION_CHECKS = [
  "Every captured copy of the selected set still has its recorded sha256 and byte count",
  "The target's .gitattributes routes every destination through Git LFS",
  "No destination already held other content",
  "The selection commit changes exactly the selected destinations, on top of the worker's commit",
  "Each committed Git LFS pointer carries the member's sha256 and byte count",
];

/**
 * The controller candidate receipt for result and final review: per item,
 * every captured set (id, provenance, worker-declared relationships,
 * production and format metadata, each member's role, destination, media
 * type, size and sha256), the capture checks every set passed, and the
 * operator's selection. Factory's private copy of each member within the
 * review bounds goes to `media-sets/<item>/<set>/` under `root`, checked
 * against its recorded digest, so the reviewer can compare the sets' bytes.
 * Returns one receipt per item, as JSON text.
 */
export async function candidateReceipts(
  root: string,
  records: readonly CandidateRecord[],
): Promise<{ item: string; content: string }[]> {
  let budget = REVIEW_CANDIDATE_BYTES;
  const receipts = [];
  for (const { item, sets, selection } of records) {
    const described = [];
    for (const set of sets) {
      const members = [];
      for (const member of set.members) {
        const relative = `media-sets/${safeName(item.id)}/${set.id.toLowerCase()}/${basename(member.file)}`;
        const copied = await reviewCopy(root, relative, member, budget);
        if (copied) budget -= member.bytes;
        members.push({
          role: member.role,
          destination: member.destination,
          mediaType: member.mediaType,
          bytes: member.bytes,
          sha256: member.sha256,
          reviewCopy: copied ? relative : null,
          ...(member.formatMetadata !== undefined && {
            declaredFormatMetadata: member.formatMetadata,
          }),
        });
      }
      described.push({
        id: set.id,
        selected: set.id === selection.set.id,
        provenance: set.provenance,
        ...(set.relationships !== undefined && {
          declaredRelationships: set.relationships,
        }),
        ...(set.production !== undefined && {
          declaredProduction: set.production,
        }),
        members,
      });
    }
    const roles = [
      ...new Set(sets.flatMap((s) => s.members.map((m) => m.role))),
    ];
    const digests = (role: string) =>
      new Set(
        sets.map((s) => s.members.find((m) => m.role === role)?.sha256 ?? ""),
      ).size;
    receipts.push({
      item: item.id,
      content: JSON.stringify({
        record:
          "Factory controller candidate receipt: built by Factory from the sets it captured and the operator's answer, not written by the worker. Fields named declared* are the worker's manifest declarations, checked only for shape.",
        workItem: item.id,
        minimumSets: item.minimumAssetSets ?? 1,
        expectedRoles: item.expectedOutputRoles ?? [],
        capturedSets: sets.length,
        captureChecksPassedByEverySet: CAPTURE_CHECKS,
        rolesWhoseBytesDifferAcrossSets: roles.filter((r) => digests(r) > 1),
        rolesWithIdenticalBytesAcrossSets: roles.filter(
          (r) => digests(r) === 1,
        ),
        sets: described,
        selection: {
          set: selection.set.id,
          by: selection.by,
          at: selection.at,
          ...(selection.reason ? { operatorReason: selection.reason } : {}),
          boundTo: selection.bound,
          selectionCommit: selection.commit,
          checksPassed: SELECTION_CHECKS,
        },
        delivery:
          "Only the selected set is written at its destinations, then validated (its members hydrated in the fresh validation checkout and checked against their sha256 and size before the validation commands ran), reviewed, published and merged. Unselected sets stay in Factory's private staging: they are never committed, validated or delivered.",
        reviewCopies:
          "reviewCopy is the evidence-root path of Factory's private copy of the member, checked against its sha256; null when the member exceeds the review copy bounds.",
      }),
    });
  }
  return receipts;
}

/**
 * Factory's private copy of `file` at `relative` under `root`, when it is
 * within the review bounds and still has its recorded digest.
 */
async function reviewCopy(
  root: string,
  relative: string,
  file: { file: string; sha256: string; bytes: number },
  budget: number,
): Promise<boolean> {
  if (file.bytes > Math.min(REVIEW_MEMBER_BYTES, budget)) return false;
  const target = join(root, relative);
  await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
  const held = await copyFile(file.file, target)
    .then(() => digestFile(target))
    .catch(() => undefined);
  if (held?.sha256 === file.sha256 && held.bytes === file.bytes) return true;
  await rm(target, { force: true });
  return false;
}

/** The read-only inputs one item's worker got (resolveInputs), for review. */
export interface InputRecord {
  item: string;
  inputs: readonly MediaInput[];
}

/**
 * The controller input receipt for result and final review: per item, each
 * file its worker got as read-only input (a source asset's kind, path and
 * visibility, or the dependency selection it came from), with media type,
 * size and sha256. Factory's copy within the review bounds goes to
 * `inputs/<item>/` under `root`, checked against its digest, so the
 * reviewer judges the same bytes the worker read.
 */
export async function inputReceipts(
  root: string,
  records: readonly InputRecord[],
): Promise<{ item: string; content: string }[]> {
  let budget = REVIEW_CANDIDATE_BYTES;
  const receipts = [];
  for (const { item, inputs } of records) {
    if (!inputs.length) continue;
    const described = [];
    for (const [index, { file, ...input }] of inputs.entries()) {
      const relative = `inputs/${safeName(item)}/${index}-${safeName(input.destination ?? input.path ?? input.role)}`;
      const copied = await reviewCopy(
        root,
        relative,
        { file, ...input },
        budget,
      );
      if (copied) budget -= input.bytes;
      described.push({ ...input, reviewCopy: copied ? relative : null });
    }
    receipts.push({
      item,
      content: JSON.stringify({
        record:
          "Factory controller input receipt: the exact files Factory gave this Work Item's worker as read-only inputs (Objective source assets, and dependencies' selected media bound to it), with the digests Factory recorded when it fetched or copied them. Built by Factory, not written by the worker.",
        workItem: item,
        inputs: described,
        reviewCopies:
          "reviewCopy is the evidence-root path of Factory's copy of the input, checked against its sha256; null when it exceeds the review copy bounds or no longer matches.",
      }),
    });
  }
  return receipts;
}

// ── Bytes ───────────────────────────────────────────────────────────────

/**
 * The local LFS store's file for `oid`, when the checkout has it: `relative`
 * under `root`, the checkout's common Git directory.
 */
async function lfsObject(
  checkout: string,
  oid: string,
  signal: AbortSignal,
): Promise<{ root: string; relative: string } | undefined> {
  const common = (
    await hostGit(
      checkout,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal },
    )
  )
    .toString("utf8")
    .trim();
  const relative = `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  return lstatSync(join(common, relative), {
    throwIfNoEntry: false,
  })?.isFile()
    ? { root: common, relative }
    : undefined;
}

/** Git's test for text: no NUL byte in the first 8000 bytes. */
async function textContent(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return !head.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Copy a local LFS object to `file`, reached without links, and check it
 * against the pointer it stands for.
 */
async function copyChecked(
  from: { root: string; relative: string },
  file: string,
  expected: { oid: string; size: number },
): Promise<Copied> {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const held = await copyContained(
    from.root,
    from.relative,
    file,
    expected.size,
  ).catch((error: unknown) => {
    if (error instanceof ContainedError) return undefined;
    throw error;
  });
  if (held?.sha256 !== expected.oid || held.bytes !== expected.size) {
    await rm(file, { force: true });
    return objectiveWide(
      hold(
        `The local Git LFS object ${expected.oid} is not a regular file holding the bytes its name says. Remove it from the checkout's .git/lfs/objects and answer retry, or cancel.`,
      ),
    );
  }
  return { kind: "done", value: held };
}

async function digestFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
