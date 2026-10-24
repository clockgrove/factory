#!/usr/bin/env node
// Pass-through GitHub API proxy that counts requests (the bounded-cost group).
// Usage: node gh-count-proxy.mjs <port> <log.jsonl>
// Point the service at it with FACTORY_GITHUB_API=http://127.0.0.1:<port>.
// It forwards every request unchanged to https://api.github.com and logs one
// JSON line per request: time, method, path, a GraphQL kind, status, ms.
// Headers (and so the token) are never logged.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, logFile] = process.argv.slice(2);
const UPSTREAM = "https://api.github.com";
const DROP = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
]);

function kind(body) {
  try {
    const q = JSON.parse(body).query ?? "";
    if (q.includes("items(first: 100")) return "queue:items";
    if (q.includes("recent: issues")) return "queue:issues";
    return q.replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    return "?";
  }
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const start = Date.now();
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => !DROP.has(k)),
  );
  let status = 0;
  try {
    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
    });
    status = up.status;
    const out = Buffer.from(await up.arrayBuffer());
    const h = {};
    up.headers.forEach((v, k) => {
      if (
        ![
          "content-encoding",
          "transfer-encoding",
          "content-length",
          "connection",
        ].includes(k)
      )
        h[k] = v;
    });
    h["content-length"] = String(out.length);
    res.writeHead(up.status, h);
    res.end(out);
  } catch (error) {
    status = 599;
    res.writeHead(502);
    res.end(String(error));
  }
  appendFileSync(
    logFile,
    `${JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      path: req.url.split("?")[0],
      gql: req.url.startsWith("/graphql") ? kind(body.toString()) : undefined,
      status,
      ms: Date.now() - start,
    })}\n`,
  );
}).listen(Number(port), "127.0.0.1");
