import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

/** Explicit ephemeral consumers, never a command journal or execution authority. */
export interface LocalWakeTarget {
  repository: string;
  /** Omitted for repository discovery; present for the active Objective's commands. */
  objective?: number;
}

const SEND_TIMEOUT_MS = 250;
const MAX_ENDPOINTS = 128;
const MAX_MESSAGE_BYTES = 256;

function identity(target: LocalWakeTarget): string {
  return createHash("sha256")
    .update(JSON.stringify([target.repository.toLowerCase(), target.objective ?? "discovery"]))
    .digest("hex")
    .slice(0, 32);
}

async function directory(): Promise<string> {
  if (process.platform !== "linux" || !process.getuid) throw new Error("local wake unavailable");
  // A fixed short path avoids Unix socket path limits and differing client/service TMPDIRs.
  const path = `/tmp/clockgrove-factory-wake-${process.getuid()}`;
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw new Error("local wake directory is not private to this user");
  return path;
}

/** Register before the consumer's first authoritative observation. Delivery is only a hint. */
export async function subscribeLocalWake(
  target: LocalWakeTarget,
  onWake: (observation: { publishedAt: number; receivedAt: number }) => void,
): Promise<() => Promise<void>> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(SEND_TIMEOUT_MS, () => socket.destroy());
    let message = "";
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      message += chunk.toString("utf8");
      if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      if (!message.includes("\n")) return;
      const [request, timestamp] = message.slice(0, message.indexOf("\n")).split(" ");
      const publishedAt = Number(timestamp);
      if (
        request &&
        /^[a-f0-9]{64}$/.test(request) &&
        Number.isSafeInteger(publishedAt) &&
        publishedAt > 0
      ) {
        try {
          onWake({ publishedAt, receivedAt: Date.now() });
        } catch {
          /* Diagnostics cannot reject a published request. */
        }
      }
      socket.end();
    });
  });
  // Unsupported transports retain periodic observation, including startup failures.
  server.on("error", () => {});
  try {
    const path = join(
      await directory(),
      `${identity(target)}-${process.pid}-${randomBytes(8).toString("hex")}.sock`,
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.unref();
    return async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  } catch {
    server.close();
    return async () => {};
  }
}

/** Called only after publication and discovery repair succeed. Failure never rolls them back. */
export async function publishLocalWake(
  target: LocalWakeTarget,
  requestId: string,
  publishedAt = Date.now(),
): Promise<void> {
  try {
    const root = await directory();
    const prefix = `${identity(target)}-`;
    const candidates = (await readdir(root)).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".sock"),
    );
    const endpoints: string[] = [];
    for (const name of candidates) {
      const pid = Number(name.slice(prefix.length).split("-")[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          // The endpoint name belongs to a departed receiver, never a work record.
          // Random endpoint names are not reused, so this cannot remove a successor's endpoint.
          const endpoint = join(root, name);
          const stat = await lstat(endpoint).catch(() => null);
          if (stat?.isSocket()) await unlink(endpoint).catch(() => {});
          continue;
        }
      }
      endpoints.push(name);
    }
    const message = `${createHash("sha256").update(requestId).digest("hex")} ${publishedAt}\n`;
    await Promise.all(
      endpoints.slice(0, MAX_ENDPOINTS).map(
        (name) =>
          new Promise<void>((resolve) => {
            const socket = createConnection(join(root, name));
            const timer = setTimeout(done, SEND_TIMEOUT_MS);
            function done() {
              clearTimeout(timer);
              socket.destroy();
              resolve();
            }
            socket.once("error", done);
            socket.once("close", done);
            socket.once("connect", () => socket.end(message));
          }),
      ),
    );
  } catch {
    /* Another host/process or unavailable IPC uses the bounded observation backstop. */
  }
}
