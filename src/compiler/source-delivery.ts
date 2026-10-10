import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PlanningRequest } from "../contracts.js";

type Sources = PlanningRequest<unknown>["sources"];

/** Complete current-call files; source identities and provenance stay separate. */
export interface PlanningSourceDelivery {
  root: string;
  baseSha: string;
  sourcesDigest: string;
  files: {
    sourceIndex: number;
    file: string;
    encoding: "utf-8";
    bytes: number;
    digest: string;
    lineCount: number;
    complete: true;
  }[];
  reusedSourceIndices: number[];
}

/** Adapter-owned proof of source bytes supplied by a completed earlier turn. */
export interface DeliveredPlanningSources {
  baseSha: string;
  sources: { path: string; heading?: string; digest: string }[];
}

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Each read profile exposes only this request's canonical source set. */
export function planningSourceDirectory(
  privateRoot: string,
  baseSha: string,
  sources: Sources,
): string {
  return join(
    privateRoot,
    "sources",
    digest(JSON.stringify([baseSha, sources])),
  );
}

export function deliveredPlanningSources(
  baseSha: string,
  sources: Sources,
  suppliedSourceIndices = sources.map((_, index) => index),
  previous?: DeliveredPlanningSources,
) {
  if (previous) assertDeliveredPlanningSources(previous);
  if (
    suppliedSourceIndices.some(
      (index, position) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= sources.length ||
        (position > 0 && index <= suppliedSourceIndices[position - 1]!),
    )
  )
    throw new Error("Supplied planning source indices are not canonical");
  return {
    baseSha,
    sources: sources.flatMap(({ path, heading, content }, index) => {
      const identity = {
        path,
        ...(heading === undefined ? {} : { heading }),
        digest: digest(content),
      };
      return suppliedSourceIndices.includes(index) ||
        (previous?.baseSha === baseSha &&
          previous.sources.some(
            (source) =>
              source.path === path &&
              source.heading === heading &&
              source.digest === identity.digest,
          ))
        ? [identity]
        : [];
    }),
  };
}

export function assertDeliveredPlanningSources(
  value: unknown,
): asserts value is DeliveredPlanningSources {
  const supplied = value as DeliveredPlanningSources | undefined;
  if (
    !supplied ||
    typeof supplied.baseSha !== "string" ||
    !Array.isArray(supplied.sources) ||
    supplied.sources.some(
      (source) =>
        !source ||
        typeof source.path !== "string" ||
        (source.heading !== undefined && typeof source.heading !== "string") ||
        typeof source.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(source.digest),
    )
  )
    throw new Error(
      "Retained delivered planning sources are not authenticated identities",
    );
}

function directory(path: string) {
  mkdirSync(path, { mode: 0o700 });
}

/** Rehydrate only canonical bytes; an existing changed file never gets repaired. */
export function materializePlanningSources(
  root: string,
  baseSha: string,
  sources: Sources,
  delivered?: DeliveredPlanningSources,
): PlanningSourceDelivery {
  if (delivered) assertDeliveredPlanningSources(delivered);
  if (resolve(root) !== root)
    throw new Error("Planning source root must be an absolute canonical path");
  const parent = dirname(root);
  if (!lstatSync(parent, { throwIfNoEntry: false })) directory(parent);
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent)
    throw new Error("Planning source parent is not an owned directory");
  if (!lstatSync(root, { throwIfNoEntry: false })) directory(root);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root)
    throw new Error("Planning source root is not an owned directory");
  const pinned = join(root, "pinned");
  if (!lstatSync(pinned, { throwIfNoEntry: false })) directory(pinned);
  if (!lstatSync(pinned).isDirectory() || realpathSync(pinned) !== pinned)
    throw new Error("Planning pinned source directory is not owned");
  const expectedFiles = new Set(
    sources.map(({ content }) => `${digest(content)}.txt`),
  );
  if (
    readdirSync(root).some((entry) => entry !== "pinned") ||
    readdirSync(pinned).some((entry) => !expectedFiles.has(entry))
  )
    throw new Error("Planning source directory contains noncanonical data");
  const current = deliveredPlanningSources(baseSha, sources);
  const files = sources.map(({ content }, sourceIndex) => {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.toString("utf8") !== content)
      throw new Error("Planning source is not complete UTF-8 text");
    const sourceDigest = digest(bytes);
    const file = `pinned/${sourceDigest}.txt`;
    const path = join(root, file);
    if (!lstatSync(path, { throwIfNoEntry: false }))
      writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o400 ||
      !readFileSync(path).equals(bytes)
    )
      throw new Error(
        "Immutable planning source file differs from pinned bytes",
      );
    return {
      sourceIndex,
      file,
      encoding: "utf-8" as const,
      bytes: bytes.length,
      digest: sourceDigest,
      lineCount: content.split("\n").length,
      complete: true as const,
    };
  });
  return {
    root,
    baseSha,
    sourcesDigest: digest(JSON.stringify(sources)),
    files,
    reusedSourceIndices: current.sources.flatMap((source, index) =>
      delivered?.baseSha === baseSha &&
      delivered.sources.some(
        (previous) =>
          previous.path === source.path &&
          previous.heading === source.heading &&
          previous.digest === source.digest,
      )
        ? [index]
        : [],
    ),
  };
}

/** Validate the complete catalog against canonical sources before body omission. */
export function assertPlanningSourceDelivery(
  delivery: PlanningSourceDelivery,
  baseSha: string,
  sources: Sources,
): void {
  if (
    delivery.baseSha !== baseSha ||
    delivery.sourcesDigest !== digest(JSON.stringify(sources))
  )
    throw new Error(
      "Planning source delivery differs from complete pinned sources",
    );
  const expected = materializePlanningSources(delivery.root, baseSha, sources);
  if (
    delivery.baseSha !== baseSha ||
    delivery.sourcesDigest !== expected.sourcesDigest ||
    JSON.stringify(delivery.files) !== JSON.stringify(expected.files) ||
    !Array.isArray(delivery.reusedSourceIndices) ||
    delivery.reusedSourceIndices.some(
      (index, position) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= sources.length ||
        (position > 0 && index <= delivery.reusedSourceIndices[position - 1]!),
    )
  )
    throw new Error(
      "Planning source delivery differs from complete pinned sources",
    );
}
