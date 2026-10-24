#!/usr/bin/env node
// A minimal forward proxy for the proxy-without-scheme drill (followups.proxy-noscheme).
// Usage: node connect-proxy.mjs <port> <log.jsonl>
// It tunnels CONNECT and forwards plain-HTTP absolute URLs, accepting any
// proxy credential without checking it. It logs only the method, the target
// host:port and whether a Proxy-Authorization header came with the request
// (never its value or any other header).
import { appendFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";

const [port, logFile] = process.argv.slice(2);
const note = (method, target, req) =>
  appendFileSync(
    logFile,
    `${JSON.stringify({ at: new Date().toISOString(), method, target, auth: "proxy-authorization" in req.headers })}\n`,
  );

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  note(req.method, url.host, req);
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  const up = request(
    {
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers,
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});
server.on("connect", (req, socket, head) => {
  note("CONNECT", req.url, req);
  const [host, p] = req.url.split(":");
  const up = connect(Number(p) || 443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(Number(port), "127.0.0.1");
