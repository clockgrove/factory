import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 100_000;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

interface ZipEntry {
  name: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  directory: boolean;
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function safeChild(root: string, relative: string): string {
  if (!safeRelativePath(relative))
    throw new Error(`ZIP archive contains an unsafe path: ${relative}`);
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relative);
  if (!target.startsWith(`${absoluteRoot}/`)) throw new Error("ZIP archive path escaped its root");
  return target;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error("ZIP archive lacks a valid end-of-central-directory record");
}

function readEntries(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount)
    throw new Error("multi-disk ZIP archives are unsupported");
  if (entryCount === 0 || entryCount > MAX_ENTRIES || entryCount === 0xffff)
    throw new Error("ZIP archive has an invalid entry count");
  if (centralOffset + centralSize > eocd)
    throw new Error("ZIP central directory lies outside the archive");

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalOutput = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
      throw new Error("ZIP central directory is malformed");
    const madeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const storedCrc32 = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length) throw new Error("ZIP central directory entry is truncated");
    if ((flags & 0x1) !== 0) throw new Error("encrypted ZIP entries are unsupported");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new Error("ZIP64 archives are unsupported");
    if (compression !== 0 && compression !== 8)
      throw new Error(`ZIP compression method ${compression} is unsupported`);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
    if (!safeRelativePath(normalized))
      throw new Error(`ZIP archive contains an unsafe path: ${name}`);
    const host = madeBy >>> 8;
    const unixType = (externalAttributes >>> 16) & 0o170000;
    const directory =
      name.endsWith("/") || (externalAttributes & 0x10) !== 0 || unixType === 0o040000;
    if (host === 3 && unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000)
      throw new Error("ZIP archive contains a symbolic link or special file");
    totalOutput += uncompressedSize;
    if (totalOutput > MAX_OUTPUT_BYTES)
      throw new Error("ZIP archive expands beyond the supported bound");
    entries.push({
      name: normalized,
      flags,
      compression,
      crc32: storedCrc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      directory,
    });
    offset = end;
  }
  if (offset !== centralOffset + centralSize)
    throw new Error("ZIP central directory size is inconsistent");
  return entries;
}

export function extractZipArchive(archive: Buffer, target: string, executablePath: string): void {
  const entries = readEntries(archive);
  if (!entries.some((entry) => !entry.directory && entry.name === executablePath))
    throw new Error("managed runtime archive lacks its declared executable");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const destination = safeChild(target, entry.name);
    if (entry.directory) {
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    const offset = entry.localOffset;
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== LOCAL_SIGNATURE)
      throw new Error("ZIP local file header is malformed");
    const localFlags = archive.readUInt16LE(offset + 6);
    const localCompression = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (
      dataEnd > archive.length ||
      localFlags !== entry.flags ||
      localCompression !== entry.compression
    )
      throw new Error("ZIP local file metadata is inconsistent");
    const localName = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    if (localName.replace(/\/$/, "") !== entry.name)
      throw new Error("ZIP local and central entry names differ");
    const compressed = archive.subarray(dataOffset, dataEnd);
    const bytes =
      entry.compression === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
    if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32)
      throw new Error("ZIP entry failed size or CRC verification");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
  }
}
