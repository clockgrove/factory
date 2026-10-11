import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  ContentMetadata,
  ContentRef,
  ContentStore,
} from "../contracts.js";

function assertRef(ref: ContentRef): void {
  if (
    !/^[0-9a-f]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0
  )
    throw new Error("Invalid content reference");
}

async function verifyFile(path: string, ref: ContentRef): Promise<void> {
  if (!existsSync(path) || !lstatSync(path).isFile())
    throw new Error(`Content object ${ref.digest} is missing`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== ref.bytes || hash.digest("hex") !== ref.digest)
    throw new Error(`Content object ${ref.digest} failed digest verification`);
}

export class LocalContentStore implements ContentStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private path(ref: ContentRef): string {
    assertRef(ref);
    return join(this.root, ref.digest.slice(0, 2), ref.digest);
  }

  /** Retain small controller manifests before publishing the atomic snapshot. */
  putBytes(bytes: Uint8Array, metadata: ContentMetadata): ContentRef {
    if (!metadata.mediaType) throw new Error("Content metadata is incomplete");
    const ref = {
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      mediaType: metadata.mediaType,
    };
    const path = this.path(ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    let complete = false;
    try {
      let offset = 0;
      while (offset < bytes.byteLength)
        offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
      fsyncSync(fd);
      complete = true;
    } finally {
      closeSync(fd);
      if (!complete) rmSync(temporary, { force: true });
    }
    try {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      this.readBytes(ref);
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return ref;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Exact complete bytes for synchronous controller retention and lookup. */
  readBytes(ref: ContentRef): Buffer {
    const path = this.path(ref);
    if (realpathSync(dirname(path)) !== resolve(dirname(path)))
      throw new Error("Content object parent resolves through a symlink");
    if (!lstatSync(path).isFile())
      throw new Error("Content object must be a regular file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new Error("Content object must be an owned private regular file");
      const bytes = readFileSync(fd);
      if (
        bytes.length !== ref.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== ref.digest
      )
        throw new Error(
          `Content object ${ref.digest} failed digest verification`,
        );
      return bytes;
    } finally {
      closeSync(fd);
    }
  }

  async put(
    stream: ReadableStream<Uint8Array>,
    metadata: ContentMetadata,
  ): Promise<ContentRef> {
    if (!metadata.mediaType) throw new Error("Content metadata is incomplete");
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    const reader = stream.getReader();
    const fd = openSync(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    let complete = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        hash.update(chunk);
        bytes += chunk.length;
        if (!Number.isSafeInteger(bytes))
          throw new Error("Content byte count overflow");
        let offset = 0;
        while (offset < chunk.length)
          offset += writeSync(fd, chunk, offset, chunk.length - offset);
      }
      fsyncSync(fd);
      complete = true;
    } finally {
      reader.releaseLock();
      closeSync(fd);
      if (!complete) rmSync(temporary, { force: true });
    }
    const ref = {
      digest: hash.digest("hex"),
      bytes,
      mediaType: metadata.mediaType,
    };
    const path = this.path(ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.verify(ref);
      return ref;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  async importFile(
    path: string,
    metadata: ContentMetadata,
  ): Promise<ContentRef> {
    if (
      !isAbsolute(path) ||
      !lstatSync(path).isFile() ||
      realpathSync(path) !== resolve(path)
    )
      throw new Error(
        "Content source must be an absolute regular file without symlinks",
      );
    const parent = dirname(path);
    if (realpathSync(parent) !== resolve(parent))
      throw new Error("Content source parent resolves through a symlink");
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stream = Readable.toWeb(
      createReadStream(path, { fd: descriptor, autoClose: true }),
    ) as ReadableStream<Uint8Array>;
    return this.put(stream, metadata);
  }

  async open(ref: ContentRef): Promise<ReadableStream<Uint8Array>> {
    await this.verify(ref);
    return Readable.toWeb(
      createReadStream(this.path(ref)),
    ) as ReadableStream<Uint8Array>;
  }

  async verify(ref: ContentRef): Promise<void> {
    await verifyFile(this.path(ref), ref);
  }

  async materialize(ref: ContentRef, destination: string): Promise<void> {
    if (!isAbsolute(destination) || existsSync(destination))
      throw new Error("Content destination must be a new absolute path");
    await this.verify(ref);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(this.path(ref), destination, constants.COPYFILE_EXCL);
    await verifyFile(destination, ref);
  }
}
