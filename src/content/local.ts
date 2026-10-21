import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ContentMetadata,
  ContentRef,
  ContentStore,
} from "../contracts.js";
import { pinnedGitEnvironment } from "../process.js";
import {
  cachedRecoveryCheckpointReferences,
  checkpointClosureBytes,
  checkpointContentVerified,
  deferCheckpointClosureVerification,
  type RecoveryCheckpointReferenceSummary,
  retainCheckpointClosureBytes,
  retainCheckpointContentVerification,
  retainRecoveryCheckpointReferences,
} from "../recovery-checkpoint.js";

function assertRef(ref: ContentRef): void {
  if (
    !/^[0-9a-f]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0
  )
    throw new Error("Invalid content reference");
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Link retained bytes into place; an existing link already holds them. */
function linkBody(temporary: string, path: string): void {
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
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

  /**
   * Where a reclaimed body is archived (#1657): `archived/<xx>/<digest>`
   * names an acknowledged evidence commit whose `blobs` tree holds it in the
   * installation's local publisher repository, which drops no object.
   */
  private archivedPath(digest: string): string {
    return join(this.root, "archived", digest.slice(0, 2), digest);
  }

  /**
   * Delete local copies of bodies the acknowledged `commit` holds. Each one is
   * indexed first, so a reader (or a writer that reused it a moment before)
   * reads it back through the archive.
   */
  reclaimArchived(commit: string, digests: Iterable<string>): number {
    if (!/^[a-f0-9]{40,64}$/.test(commit))
      throw new Error("Invalid archive commit");
    const candidates = [...digests].filter(
      (digest) =>
        /^[a-f0-9]{64}$/.test(digest) &&
        existsSync(join(this.root, digest.slice(0, 2), digest)),
    );
    // The blob object itself must be in the publisher, not only its entry.
    const sizes = candidates.length
      ? this.publisherGit(
          ["cat-file", "--batch-check=%(objecttype) %(objectsize)"],
          candidates.map((digest) => `${commit}:blobs/${digest}\n`).join(""),
        )
          .toString("utf8")
          .split("\n")
      : [];
    let deleted = 0;
    for (const [index, digest] of candidates.entries()) {
      const body = join(this.root, digest.slice(0, 2), digest);
      if (sizes[index] !== `blob ${lstatSync(body).size}`) continue;
      const entry = this.archivedPath(digest);
      mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
      const temporary = `${entry}.${randomUUID()}.tmp`;
      writeFileSync(temporary, commit, { mode: 0o600 });
      renameSync(temporary, entry);
      rmSync(body, { force: true });
      deleted++;
    }
    return deleted;
  }

  private publisherGit(args: string[], input?: string, maxBuffer?: number) {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        `--git-dir=${join(dirname(this.root), "recovery", "git.git")}`,
        ...args,
      ],
      {
        env: pinnedGitEnvironment(),
        input,
        ...(maxBuffer === undefined ? {} : { maxBuffer }),
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  /**
   * Read-through for a reclaimed body: copy it back from the local publisher
   * repository, exact to its digest. False when it is not archived there,
   * which leaves the body missing as before.
   */
  private restoreArchived(ref: ContentRef): boolean {
    let commit: string;
    try {
      commit = readFileSync(this.archivedPath(ref.digest), "utf8");
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return false;
    const spec = `${commit}:blobs/${ref.digest}`;
    // A genuinely absent object leaves the body missing; any other publisher
    // failure surfaces.
    if (
      this.publisherGit(
        ["cat-file", "--batch-check=%(objecttype)"],
        `${spec}\n`,
      )
        .toString("utf8")
        .trim() !== "blob"
    )
      return false;
    let bytes: Buffer;
    try {
      bytes = this.publisherGit(
        ["cat-file", "blob", spec],
        undefined,
        ref.bytes + 1,
      );
    } catch (error) {
      throw new Error(
        `Archived content object ${ref.digest} is unreadable from the local publisher`,
        { cause: error },
      );
    }
    if (
      bytes.length !== ref.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== ref.digest
    )
      throw new Error(
        `Archived content object ${ref.digest} failed digest verification`,
      );
    const path = this.path(ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkBody(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return true;
  }

  /** Run a read once more after restoring a body reclaimed under it. */
  private readThrough<T>(ref: ContentRef, read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (!missing(error) || !this.restoreArchived(ref)) throw error;
      return read();
    }
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
      linkBody(temporary, path);
      if (!this.retainExisting(ref)) {
        // Reclaimed between the link and its check: link these bytes.
        linkBody(temporary, path);
        if (!this.retainExisting(ref))
          throw new Error(`Content object ${ref.digest} is missing`);
      }
      return ref;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private openObject(ref: ContentRef): number {
    const path = this.path(ref);
    // One native resolution, not a JavaScript walk with an lstat per path
    // component: this runs for every original of every closure.
    if (realpathSync.native(dirname(path)) !== resolve(dirname(path)))
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

  private readDescriptor(
    fd: number,
    ref: ContentRef,
  ): { bytes: Buffer; identity: string } {
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
    return { bytes, identity };
  }

  private retainExisting(ref: ContentRef): boolean {
    let fd: number;
    try {
      fd = this.openObject(ref);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    try {
      this.verifyDescriptor(fd, ref);
      this.synchronizeObject(fd, ref);
      return true;
    } catch (error) {
      // Reclaimed under this writer: it writes the body again.
      if (missing(error)) return false;
      throw error;
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
    if (
      Object.getPrototypeOf(this) === LocalContentStore.prototype &&
      this.verifyPrivateBytes ===
        LocalContentStore.prototype.verifyPrivateBytes &&
      deferCheckpointClosureVerification(this.root, ref)
    )
      return;
    this.readThrough(ref, () => {
      const fd = this.openObject(ref);
      try {
        this.verifyDescriptor(fd, ref);
      } finally {
        closeSync(fd);
      }
    });
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
    return this.readThrough(ref, () => {
      const fd = this.openObject(ref);
      try {
        const { bytes, identity } = this.readDescriptor(fd, ref);
        if (concrete)
          retainCheckpointClosureBytes(this.root, ref, bytes, identity);
        return bytes;
      } finally {
        closeSync(fd);
      }
    });
  }

  checkpointReferences(
    description: string,
  ): RecoveryCheckpointReferenceSummary | undefined {
    return Object.getPrototypeOf(this) === LocalContentStore.prototype &&
      this.readBytes === LocalContentStore.prototype.readBytes
      ? cachedRecoveryCheckpointReferences(this.root, description)
      : undefined;
  }

  retainCheckpointReferences(
    description: string,
    summary: RecoveryCheckpointReferenceSummary,
    slot?: string,
  ): void {
    if (
      Object.getPrototypeOf(this) === LocalContentStore.prototype &&
      this.readBytes === LocalContentStore.prototype.readBytes
    )
      retainRecoveryCheckpointReferences(this.root, description, summary, slot);
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
      // A body reclaimed under this check (missing, or restored as another
      // file) is linked and checked once more.
      for (let attempt = 0; ; attempt++)
        try {
          linkBody(temporary, path);
          const retained = this.openObject(ref);
          try {
            const identity = this.descriptorIdentity(retained, ref, false);
            // One streamed digest read authenticates the final linked object. Bind
            // it to the same opened file, then make that link durable at its producer.
            await this.verify(ref);
            if (this.descriptorIdentity(retained, ref, false) !== identity)
              throw new Error(
                "Content object changed during streamed retention",
              );
            this.synchronizeObject(retained, ref, false);
            const current = fstatSync(retained);
            if (current.uid === process.getuid?.() && !(current.mode & 0o077))
              retainCheckpointContentVerification(this.root, ref, identity);
          } finally {
            closeSync(retained);
          }
          return ref;
        } catch (error) {
          if (attempt) throw error;
        }
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

  /** A descriptor whose bytes match the ref, held from its verification on. */
  private async openVerified(ref: ContentRef): Promise<number> {
    const fd = this.readThrough(ref, () => this.openObject(ref));
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream("", {
        fd,
        start: 0,
        autoClose: false,
      })) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      if (bytes !== ref.bytes || hash.digest("hex") !== ref.digest)
        throw new Error(
          `Content object ${ref.digest} failed digest verification`,
        );
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  async open(ref: ContentRef): Promise<ReadableStream<Uint8Array>> {
    const fd = await this.openVerified(ref);
    return Readable.toWeb(
      createReadStream("", { fd, start: 0, autoClose: true }),
    ) as ReadableStream<Uint8Array>;
  }

  async verify(ref: ContentRef): Promise<void> {
    if (!existsSync(this.path(ref))) this.restoreArchived(ref);
    await verifyFile(this.path(ref), ref);
  }

  async materialize(ref: ContentRef, destination: string): Promise<void> {
    if (!isAbsolute(destination) || existsSync(destination))
      throw new Error("Content destination must be a new absolute path");
    const fd = await this.openVerified(ref);
    try {
      mkdirSync(dirname(destination), { recursive: true });
      await pipeline(
        createReadStream("", { fd, start: 0, autoClose: false }),
        createWriteStream(destination, {
          flags: "wx",
          mode: fstatSync(fd).mode & 0o777,
        }),
      );
    } finally {
      closeSync(fd);
    }
    await verifyFile(destination, ref);
  }
}
