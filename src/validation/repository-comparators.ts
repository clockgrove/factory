import { z } from "zod";

import { safeId } from "../protocol/limits.js";

const ComparatorIdentitySchema = z
  .object({ id: safeId, contract: z.number().int().positive().max(1_000) })
  .strict();

export type RepositoryComparatorIdentity = z.infer<typeof ComparatorIdentitySchema>;

const installed = [
  {
    identity: { id: "byte-difference", contract: 1 },
    resultDomain: { minimum: 0, maximum: 1 },
  },
  {
    identity: { id: "pixel-difference", contract: 1 },
    resultDomain: { minimum: 0, maximum: 1 },
  },
] as const;

export const repositoryComparatorContracts: RepositoryComparatorIdentity[] = installed.map(
  ({ identity }) => ComparatorIdentitySchema.parse(identity),
);

export interface RepositoryComparatorCapability {
  identity: RepositoryComparatorIdentity;
  resultDomain: { minimum: number; maximum: number };
}

type RepositoryComparatorProfile = Readonly<{ kind: string }>;

/** Resolve an installed comparator for one exact output contract. The same
 * capability describes compile-time applicability and the runtime scalar
 * domain, so repository configuration cannot widen either boundary. */
export function repositoryComparatorCapability(args: {
  metric: string;
  mediaType: string;
  profile: RepositoryComparatorProfile | null;
}): RepositoryComparatorCapability {
  const capability = installed.find(({ identity }) => identity.id === args.metric);
  if (!capability) throw new Error(`no installed repository comparator supports ${args.metric}`);
  if (
    capability.identity.id === "pixel-difference" &&
    (args.profile?.kind !== "raster" || !args.mediaType.startsWith("image/"))
  )
    throw new Error("pixel-difference requires the installed raster profile and image MIME");
  return {
    identity: ComparatorIdentitySchema.parse(capability.identity),
    resultDomain: { ...capability.resultDomain },
  };
}

export function repositoryComparatorIdentity(args: {
  metric: string;
  mediaType: string;
  profile: RepositoryComparatorProfile | null;
}): RepositoryComparatorIdentity {
  return repositoryComparatorCapability(args).identity;
}

function normalizedByteDifference(expected: Buffer, observed: Buffer): number {
  const total = Math.max(expected.length, observed.length);
  if (total === 0) return 0;
  let changed = Math.abs(expected.length - observed.length);
  const shared = Math.min(expected.length, observed.length);
  for (let index = 0; index < shared; index += 1)
    if (expected[index] !== observed[index]) changed += 1;
  return changed / total;
}

async function normalizedPixelDifference(expected: Buffer, observed: Buffer): Promise<number> {
  const sharp = (await import("sharp")).default;
  const decode = (bytes: Buffer) =>
    sharp(bytes, { animated: true, failOn: "warning", sequentialRead: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  const [left, right] = await Promise.all([decode(expected), decode(observed)]);
  if (
    left.info.width !== right.info.width ||
    left.info.height !== right.info.height ||
    left.info.channels !== right.info.channels ||
    left.data.length !== right.data.length
  )
    return 1;
  const channels = left.info.channels;
  const pixels = left.data.length / channels;
  if (!Number.isSafeInteger(pixels) || pixels <= 0)
    throw new Error("decoded raster comparator output is empty or malformed");
  let changed = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const start = pixel * channels;
    let differs = false;
    for (let channel = 0; channel < channels; channel += 1)
      differs ||= left.data[start + channel] !== right.data[start + channel];
    if (differs) changed += 1;
  }
  return changed / pixels;
}

/** Compare immutable payloads inside Factory after all repository-controlled
 * commands have exited. Repository code never receives the expected bytes and
 * never supplies the certified scalar. */
export async function compareRepositoryCaptureBytes(args: {
  comparator: RepositoryComparatorIdentity;
  metric: string;
  mediaType: string;
  profile: RepositoryComparatorProfile | null;
  expected: Buffer;
  observed: Buffer;
}): Promise<number> {
  const selected = repositoryComparatorCapability({
    metric: args.metric,
    mediaType: args.mediaType,
    profile: args.profile,
  });
  if (
    selected.identity.id !== args.comparator.id ||
    selected.identity.contract !== args.comparator.contract ||
    args.metric !== selected.identity.id
  )
    throw new Error("repository comparator differs from the installed contract");
  const difference =
    selected.identity.id === "pixel-difference"
      ? await normalizedPixelDifference(args.expected, args.observed)
      : normalizedByteDifference(args.expected, args.observed);
  if (
    !Number.isFinite(difference) ||
    difference < selected.resultDomain.minimum ||
    difference > selected.resultDomain.maximum
  )
    throw new Error("installed repository comparator returned an invalid difference");
  return difference;
}
