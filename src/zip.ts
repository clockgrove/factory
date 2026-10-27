/**
 * The small text files of a zip archive, read in memory: a failed Actions
 * run's uploaded artifacts for its repair finding (delivery.ts, #2094).
 * Nothing is written to disk or run; an entry is only ever decoded as
 * UTF-8 text. Only stored and deflated entries are read, each bounded
 * before and while it inflates, so a zip bomb costs at most the bound.
 */
import { inflateRawSync } from "node:zlib";

/** A text file in an archive. */
export interface ZipText {
  name: string;
  text: string;
}

/** What `zipTexts` read: the text files, and the entries it skipped, with why. */
export interface ZipListing {
  texts: ZipText[];
  skipped: { name: string; reason: string }[];
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** The end record's fixed part, and the longest comment after it. */
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;

/** Whether `data` starts like a zip archive. */
export function isZip(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt32LE(0) === LOCAL_HEADER;
}

/**
 * `data` as text, when it is UTF-8 with no NUL: anything else is not a
 * text file a diagnosis can read.
 */
export function utf8Text(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

/**
 * The entries of zip archive `data` that are text files of at most
 * `maxBytes` bytes, in the archive's order, and the other entries with why
 * they were skipped (larger, binary, encrypted, compressed some other way).
 * Directories are left out. Undefined when `data` is not a zip archive
 * Factory can read (no end record, or a Zip64 one).
 */
export function zipTexts(
  data: Buffer,
  maxBytes: number,
): ZipListing | undefined {
  const end = endRecord(data);
  if (end === undefined) return undefined;
  const count = data.readUInt16LE(end + 10);
  const offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) return undefined;
  const listing: ZipListing = { texts: [], skipped: [] };
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== DIRECTORY_ENTRY)
      return undefined;
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const skip = (reason: string) => listing.skipped.push({ name, reason });
    if (flags & 1) {
      skip("encrypted");
      continue;
    }
    if (size > maxBytes || compressed === 0xffffffff) {
      skip(`larger than ${maxBytes} bytes`);
      continue;
    }
    if (method !== 0 && method !== 8) {
      skip(`compressed with method ${method}`);
      continue;
    }
    const content = entryData(data, local, compressed);
    if (!content) return undefined;
    let file: Buffer;
    try {
      file =
        method === 0
          ? content
          : inflateRawSync(content, { maxOutputLength: maxBytes });
    } catch {
      skip("unreadable");
      continue;
    }
    const text = file.length === size ? utf8Text(file) : undefined;
    if (text === undefined) skip("not UTF-8 text");
    else listing.texts.push({ name, text });
  }
  return listing;
}

/** Where the end-of-central-directory record starts, if `data` has one. */
function endRecord(data: Buffer): number | undefined {
  const last = data.length - END_SIZE;
  for (let at = last; at >= 0 && at >= last - MAX_COMMENT; at--)
    if (data.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  return undefined;
}

/** An entry's compressed bytes, after its local header. */
function entryData(
  data: Buffer,
  local: number,
  compressed: number,
): Buffer | undefined {
  if (local + 30 > data.length || data.readUInt32LE(local) !== LOCAL_HEADER)
    return undefined;
  const start =
    local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
  if (start + compressed > data.length) return undefined;
  return data.subarray(start, start + compressed);
}
