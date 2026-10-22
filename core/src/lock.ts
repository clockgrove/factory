import { createServer, type Server } from "node:net";

/**
 * The service lock: a Linux abstract-namespace socket. Binding fails while
 * another live process holds the name, and the kernel frees the name the
 * moment that process dies, however it dies. There is no lock file to go
 * stale and no owner record to prove.
 */
export async function takeServiceLock(name: string): Promise<Server | null> {
  const server = createServer((socket) => socket.end());
  return await new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(name, () => {
      server.unref();
      resolve(server);
    });
  });
}
