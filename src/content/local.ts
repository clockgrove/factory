import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
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
import {
  checkpointClosureBytes,
  checkpointContentVerified,
  retainCheckpointClosureBytes,
  retainCheckpointContentVerification,
} from "../recovery-checkpoint.js";

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

  /** Retain complete controller bytes before publishing the atomic snapshot. */
  putBytes(bytes: Uint8Array, metadata: ContentMetadata): ContentRef {
    if (!metadata.mediaType) throw new Error("Content metadata is incomplete");
    const ref = {
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      mediaType: metadata.mediaType,
    };
    const path = this.path(ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (this.retainExisting(ref)) return ref;
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
      if (!this.retainExisting(ref))
        throw new Error(`Content object ${ref.digest} is missing`);
      return ref;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private openObject(ref: ContentRef): number {
    const path = this.path(ref);
    if (realpathSync(dirname(path)) !== resolve(dirname(path)))
      throw new Error("Content object parent resolves through a symlink");
    if (!lstatSync(path).isFile())
      throw new Error("Content object must be a regular file");
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }

  private descriptorIdentity(
    fd: number,
    ref: ContentRef,
    privateOnly = true,
  ): string {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      (privateOnly &&
        (stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o077n))
    )
      throw new Error("Content object must be an owned private regular file");
    if (stat.size !== BigInt(ref.bytes))
      throw new Error(
        `Content object ${ref.digest} failed digest verification`,
      );
    const path = lstatSync(this.path(ref), { bigint: true });
    if (
      path.isSymbolicLink() ||
      !path.isFile() ||
      path.dev !== stat.dev ||
      path.ino !== stat.ino ||
      path.size !== stat.size ||
      path.mode !== stat.mode ||
      path.uid !== stat.uid ||
      path.mtimeNs !== stat.mtimeNs ||
      path.ctimeNs !== stat.ctimeNs
    )
      throw new Error("Content object changed its opened file identity");
    return JSON.stringify(
      [
        stat.dev,
        stat.ino,
        stat.mode,
        stat.uid,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].map(String),
    );
  }

  private readDescriptor(fd: number, ref: ContentRef): Buffer {
    const identity = this.descriptorIdentity(fd, ref);
    const verified = checkpointContentVerified(this.root, ref, identity);
    const bytes = readFileSync(fd);
    if (
      bytes.length !== ref.bytes ||
      (!verified &&
        createHash("sha256").update(bytes).digest("hex") !== ref.digest)
    )
      throw new Error(
        `Content object ${ref.digest} failed digest verification`,
      );
    if (this.descriptorIdentity(fd, ref) !== identity)
      throw new Error("Content object changed during exact byte verification");
    if (!verified)
      retainCheckpointContentVerification(this.root, ref, identity);
    return bytes;
  }

  private retainExisting(ref: ContentRef): boolean {
    let fd: number;
    try {
      fd = this.openObject(ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      this.verifyDescriptor(fd, ref);
      this.synchronizeObject(fd, ref);
      return true;
    } finally {
      closeSync(fd);
    }
  }

  private verifyDescriptor(fd: number, ref: ContentRef): void {
    const identity = this.descriptorIdentity(fd, ref);
    if (!checkpointContentVerified(this.root, ref, identity))
      this.readDescriptor(fd, ref);
    else if (this.descriptorIdentity(fd, ref) !== identity)
      throw new Error(
        "Content object changed during exact reference verification",
      );
  }

  /** Authenticate a private original without allocating already verified bytes. */
  verifyPrivateBytes(ref: ContentRef): void {
    const fd = this.openObject(ref);
    try {
      this.verifyDescriptor(fd, ref);
    } finally {
      closeSync(fd);
    }
  }

  private synchronizeObject(
    fd: number,
    ref: ContentRef,
    privateOnly = true,
  ): void {
    const identity = this.descriptorIdentity(fd, ref, privateOnly);
    fsyncSync(fd);
    const directory = openSync(
      dirname(this.path(ref)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(directory);
      if (!stat.isDirectory())
        throw new Error("Content object parent is not a directory");
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    if (this.descriptorIdentity(fd, ref, privateOnly) !== identity)
      throw new Error("Content object changed during durable retention");
  }

  /** Exact complete bytes for synchronous controller retention and lookup. */
  readBytes(ref: ContentRef): Buffer {
    const concrete =
      Object.getPrototypeOf(this) === LocalContentStore.prototype &&
      this.readBytes === LocalContentStore.prototype.readBytes;
    const cached = concrete && checkpointClosureBytes(this.root, ref);
    if (cached) return cached;
    const fd = this.openObject(ref);
    try {
      const bytes = this.readDescriptor(fd, ref);
      if (concrete) retainCheckpointClosureBytes(this.root, ref, bytes);
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
      const retained = this.openObject(ref);
      try {
        const identity = this.descriptorIdentity(retained, ref, false);
        // One streamed digest read authenticates the final linked object. Bind
        // it to the same opened file, then make that link durable at its producer.
        await this.verify(ref);
        if (this.descriptorIdentity(retained, ref, false) !== identity)
          throw new Error("Content object changed during streamed retention");
        this.synchronizeObject(retained, ref, false);
        const current = fstatSync(retained);
        if (current.uid === process.getuid?.() && !(current.mode & 0o077))
          retainCheckpointContentVerification(this.root, ref, identity);
      } finally {
        closeSync(retained);
      }
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
